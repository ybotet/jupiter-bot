use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
  instruction::{AccountMeta, Instruction},
  program::invoke,
};
use anchor_spl::token::Token;
use anchor_spl::token_interface::TokenAccount;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod mev_executor {
  use super::*;

  /** Inicializa el estado persistente que autoriza futuras ejecuciones. */
  pub fn initialize(ctx: Context<InitializeExecutor>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.authority = ctx.accounts.authority.key();
    state.active = true;
    Ok(())
  }

  /** Ejecuta la compra y la venta como dos CPI atómicas y secuenciales. */
  pub fn execute_arbitrage(
    ctx: Context<ExecuteArbitrage>,
    params: ArbitrageParams,
    buy_instruction: SwapInstructionData,
    sell_instruction: SwapInstructionData,
  ) -> Result<()> {
    require!(ctx.accounts.state.active, ExecutorError::ExecutorInactive);
    require_keys_eq!(
      ctx.accounts.input_token_account.mint,
      params.input_mint,
      ExecutorError::InvalidInputMint
    );
    require_keys_eq!(
      ctx.accounts.output_token_account.mint,
      params.output_mint,
      ExecutorError::InvalidOutputMint
    );
    require!(params.input_amount > 0, ExecutorError::InvalidInputAmount);
    require!(
      params.maximum_slippage_bps <= 10_000,
      ExecutorError::InvalidSlippage
    );
    require!(
      ctx.accounts.input_token_account.amount >= params.input_amount,
      ExecutorError::InsufficientInputBalance
    );
    validate_swap_instruction(&buy_instruction)?;
    validate_swap_instruction(&sell_instruction)?;

    let initial_balance = ctx.accounts.input_token_account.amount;

    execute_swap(&buy_instruction, &ctx.remaining_accounts)?;
    ctx.accounts.output_token_account.reload()?;
    validate_output_amount(&params, ctx.accounts.output_token_account.amount)?;
    execute_swap(&sell_instruction, &ctx.remaining_accounts)?;

    ctx.accounts.input_token_account.reload()?;
    validate_profitability(
      initial_balance,
      ctx.accounts.input_token_account.amount,
      params.total_cost_estimated()?,
    )?;

    Ok(())
  }
}

/** Describe una operación de arbitraje sin ejecutar todavía los swaps. */
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ArbitrageParams {
  pub input_mint: Pubkey,
  pub output_mint: Pubkey,
  pub input_amount: u64,
  pub expected_output_amount: u64,
  pub minimum_output_amount: u64,
  pub gas_estimated: u64,
  pub jupiter_fees_estimated: u64,
  pub jito_tip_estimated: u64,
  pub maximum_slippage_bps: u16,
}

impl ArbitrageParams {
  /** Suma todos los costes estimados expresados en el mint de entrada. */
  pub fn total_cost_estimated(&self) -> Result<u64> {
    self
      .gas_estimated
      .checked_add(self.jupiter_fees_estimated)
      .and_then(|cost| cost.checked_add(self.jito_tip_estimated))
      .ok_or_else(|| error!(ExecutorError::CostOverflow))
  }
}

/** Describe una cuenta requerida por una instrucción CPI de swap. */
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SwapAccountMeta {
  pub pubkey: Pubkey,
  pub is_signer: bool,
  pub is_writable: bool,
}

/** Contiene el programa, las cuentas y los datos de un swap externo. */
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SwapInstructionData {
  pub program_id: Pubkey,
  pub accounts: Vec<SwapAccountMeta>,
  pub data: Vec<u8>,
}

/** Almacena la autoridad y el estado operativo del ejecutor. */
#[account]
pub struct ExecutorState {
  pub authority: Pubkey,
  pub active: bool,
}

/** Define las cuentas necesarias para crear el estado del ejecutor. */
#[derive(Accounts)]
pub struct InitializeExecutor<'info> {
  #[account(init, payer = authority, space = ExecutorState::SPACE)]
  pub state: Account<'info, ExecutorState>,
  #[account(mut)]
  pub authority: Signer<'info>,
  pub system_program: Program<'info, System>,
}

/** Define las cuentas que utilizará la futura ejecución atómica. */
#[derive(Accounts)]
pub struct ExecuteArbitrage<'info> {
  #[account(mut, has_one = authority)]
  pub state: Account<'info, ExecutorState>,
  pub authority: Signer<'info>,
  #[account(mut)]
  pub input_token_account: InterfaceAccount<'info, TokenAccount>,
  #[account(mut)]
  pub output_token_account: InterfaceAccount<'info, TokenAccount>,
  pub token_program: Program<'info, Token>,
}

impl ExecutorState {
  pub const SPACE: usize = 8 + 32 + 1;
}

/** Ejecuta una instrucción CPI después de resolver y validar sus cuentas. */
fn execute_swap(
  instruction_data: &SwapInstructionData,
  remaining_accounts: &[AccountInfo],
) -> Result<()> {
  let accounts = instruction_data
    .accounts
    .iter()
    .map(|account| {
      if account.is_signer {
        AccountMeta::new_readonly(account.pubkey, true)
      } else if account.is_writable {
        AccountMeta::new(account.pubkey, false)
      } else {
        AccountMeta::new_readonly(account.pubkey, false)
      }
    })
    .collect::<Vec<AccountMeta>>();

  let instruction = Instruction {
    program_id: instruction_data.program_id,
    accounts,
    data: instruction_data.data.clone(),
  };
  let program_account = remaining_accounts
    .iter()
    .find(|account| account.key() == instruction_data.program_id)
    .ok_or(ExecutorError::MissingSwapProgram)?;
  let mut account_infos = Vec::with_capacity(instruction_data.accounts.len() + 1);
  account_infos.push(program_account.clone());

  for account_meta in &instruction_data.accounts {
    let account_info = remaining_accounts
      .iter()
      .find(|account| account.key() == account_meta.pubkey)
      .ok_or(ExecutorError::MissingSwapAccount)?;
    account_infos.push(account_info.clone());
  }

  invoke(&instruction, &account_infos).map_err(Into::into)
}

/** Valida que una instrucción CPI tenga programa, cuentas y datos utilizables. */
fn validate_swap_instruction(instruction_data: &SwapInstructionData) -> Result<()> {
  require!(
    instruction_data.program_id != Pubkey::default(),
    ExecutorError::InvalidSwapProgram
  );
  require!(
    !instruction_data.accounts.is_empty(),
    ExecutorError::EmptySwapAccounts
  );
  require!(
    !instruction_data.data.is_empty(),
    ExecutorError::EmptySwapData
  );

  Ok(())
}

/** Valida la salida mínima y el slippage real después de la compra. */
fn validate_output_amount(params: &ArbitrageParams, actual_output: u64) -> Result<()> {
  require!(
    actual_output >= params.minimum_output_amount,
    ExecutorError::MinimumOutputNotMet
  );

  if actual_output < params.expected_output_amount {
    let shortfall = params.expected_output_amount - actual_output;
    let slippage_bps = shortfall
      .checked_mul(10_000)
      .and_then(|value| value.checked_div(params.expected_output_amount))
      .ok_or(ExecutorError::SlippageOverflow)?;
    require!(
      slippage_bps <= u64::from(params.maximum_slippage_bps),
      ExecutorError::SlippageExceeded
    );
  }

  Ok(())
}

/** Comprueba que el saldo final supere el inicial más el gas estimado. */
fn validate_profitability(
  initial_balance: u64,
  final_balance: u64,
  gas_estimated: u64,
) -> Result<()> {
  let minimum_final_balance = initial_balance
    .checked_add(gas_estimated)
    .ok_or(ExecutorError::BalanceOverflow)?;
  require!(
    final_balance > minimum_final_balance,
    ExecutorError::ArbitrageNotProfitable
  );

  Ok(())
}

/** Define errores explícitos para impedir ejecuciones con cuentas o parámetros inválidos. */
#[error_code]
pub enum ExecutorError {
  #[msg("El ejecutor está inactivo")]
  ExecutorInactive,
  #[msg("El mint de entrada no coincide con los parámetros")]
  InvalidInputMint,
  #[msg("El mint de salida no coincide con los parámetros")]
  InvalidOutputMint,
  #[msg("El importe de entrada debe ser positivo")]
  InvalidInputAmount,
  #[msg("La cuenta no tiene saldo suficiente para el arbitraje")]
  InsufficientInputBalance,
  #[msg("El saldo final no supera el saldo inicial más el gas estimado")]
  ArbitrageNotProfitable,
  #[msg("El cálculo del saldo final desbordó un u64")]
  BalanceOverflow,
  #[msg("La suma de los costes estimados desbordó un u64")]
  CostOverflow,
  #[msg("El slippage debe estar entre 0 y 10000 puntos básicos")]
  InvalidSlippage,
  #[msg("No se encontró la cuenta del programa del swap")]
  MissingSwapProgram,
  #[msg("No se encontró una cuenta requerida por el swap")]
  MissingSwapAccount,
  #[msg("El programa del swap no es válido")]
  InvalidSwapProgram,
  #[msg("El swap no contiene cuentas")]
  EmptySwapAccounts,
  #[msg("El swap no contiene datos de instrucción")]
  EmptySwapData,
  #[msg("La salida del swap está por debajo del mínimo permitido")]
  MinimumOutputNotMet,
  #[msg("El slippage real supera el máximo permitido")]
  SlippageExceeded,
  #[msg("El cálculo del slippage desbordó un u64")]
  SlippageOverflow,
}

#[cfg(test)]
mod tests {
  use super::*;

  /** Comprueba que un saldo final superior al umbral se acepta. */
  #[test]
  fn accepts_profitable_balance() {
    assert!(validate_profitability(1_000, 1_101, 100).is_ok());
  }

  /** Comprueba que un saldo final igual o inferior al umbral se rechaza. */
  #[test]
  fn rejects_non_profitable_balance() {
    assert!(validate_profitability(1_000, 1_100, 100).is_err());
  }

  /** Comprueba que un desbordamiento del umbral se rechaza de forma segura. */
  #[test]
  fn rejects_balance_overflow() {
    assert!(validate_profitability(u64::MAX, u64::MAX, 1).is_err());
  }

  /** Comprueba que una instrucción CPI vacía devuelve un error personalizado. */
  #[test]
  fn rejects_empty_swap_instruction() {
    let instruction = SwapInstructionData {
      program_id: Pubkey::default(),
      accounts: Vec::new(),
      data: Vec::new(),
    };

    assert!(validate_swap_instruction(&instruction).is_err());
  }

  /** Comprueba que la salida mínima impide continuar con una operación desfavorable. */
  #[test]
  fn rejects_output_below_minimum() {
    let params = ArbitrageParams {
      input_mint: Pubkey::default(),
      output_mint: Pubkey::default(),
      input_amount: 1,
      expected_output_amount: 1_000,
      minimum_output_amount: 900,
      gas_estimated: 0,
      jupiter_fees_estimated: 0,
      jito_tip_estimated: 0,
      maximum_slippage_bps: 500,
    };

    assert!(validate_output_amount(&params, 899).is_err());
  }

  /** Comprueba que el slippage real por encima del máximo se rechaza. */
  #[test]
  fn rejects_excessive_slippage() {
    let params = ArbitrageParams {
      input_mint: Pubkey::default(),
      output_mint: Pubkey::default(),
      input_amount: 1,
      expected_output_amount: 1_000,
      minimum_output_amount: 900,
      gas_estimated: 0,
      jupiter_fees_estimated: 0,
      jito_tip_estimated: 0,
      maximum_slippage_bps: 500,
    };

    assert!(validate_output_amount(&params, 949).is_err());
  }

  /** Comprueba que la suma de gas, fees Jupiter y tip de Jito es segura. */
  #[test]
  fn sums_execution_costs() {
    let params = ArbitrageParams {
      input_mint: Pubkey::default(),
      output_mint: Pubkey::default(),
      input_amount: 1,
      expected_output_amount: 1,
      minimum_output_amount: 1,
      gas_estimated: 10,
      jupiter_fees_estimated: 20,
      jito_tip_estimated: 30,
      maximum_slippage_bps: 0,
    };

    assert_eq!(params.total_cost_estimated().unwrap(), 60);
  }
}

#[derive(Accounts)]
pub struct Initialize {}
