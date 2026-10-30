/**
 * Formal verification (Lean 4 proofs) is built but not switched on in production yet: the verifier needs its own
 * server. While this is off, the Verification icon, the "Submit for Formal Verification" button and the
 * "Formally verified" taglines stay hidden. Turn it on with NEXT_PUBLIC_VERIFICATION_ENABLED=true (a build-time
 * variable: redeploy the web app after changing it).
 */
export const VERIFICATION_LIVE = process.env.NEXT_PUBLIC_VERIFICATION_ENABLED === 'true';
