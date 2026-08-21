"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const strict_1 = __importDefault(require("node:assert/strict"));
/** Ejecuta las pruebas de integración del ejecutor contra el proveedor de Anchor. */
describe('mev_executor', () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.mevExecutor;
    /** Verifica que el estado del ejecutor se crea con la autoridad del proveedor. */
    it('inicializa el estado del ejecutor', async () => {
        const state = anchor.web3.Keypair.generate();
        await program.methods
            .initialize()
            .accounts({
            state: state.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
            .signers([state])
            .rpc();
        const storedState = await program.account.executorState.fetch(state.publicKey);
        strict_1.default.equal(storedState.authority.toBase58(), provider.wallet.publicKey.toBase58());
        strict_1.default.equal(storedState.active, true);
    });
    /** Verifica que una instrucción de swap inválida revierte con un error claro. */
    it('rechaza instrucciones de swap inválidas', async () => {
        const state = anchor.web3.Keypair.generate();
        const inputTokenAccount = anchor.web3.Keypair.generate().publicKey;
        const outputTokenAccount = anchor.web3.Keypair.generate().publicKey;
        const invalidSwap = {
            programId: anchor.web3.SystemProgram.programId,
            accounts: [],
            data: Buffer.alloc(0),
        };
        await program.methods
            .initialize()
            .accounts({
            state: state.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
            .signers([state])
            .rpc();
        try {
            await program.methods
                .executeArbitrage({
                inputMint: anchor.web3.SystemProgram.programId,
                outputMint: anchor.web3.SystemProgram.programId,
                inputAmount: new anchor.BN(1),
                minimumOutputAmount: new anchor.BN(1),
                gasEstimated: new anchor.BN(0),
                maximumSlippageBps: 50,
            }, invalidSwap, invalidSwap)
                .accounts({
                state: state.publicKey,
                authority: provider.wallet.publicKey,
                inputTokenAccount,
                outputTokenAccount,
                tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            })
                .rpc();
            strict_1.default.fail('La instrucción debía revertir');
        }
        catch (error) {
            strict_1.default.match(String(error), /El swap no contiene cuentas/);
        }
    });
});
