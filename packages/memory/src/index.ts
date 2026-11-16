/**
 * @rebecca/memory
 *
 * Shared 3-layer cognitive memory architecture, Tatemae/Honne (thought/reply) history &
 * prompt composition, Layer 1 Global Evolution, Layer 2 Self-Reflection, Layer 3 Dreaming
 * consolidation, core vector/RAG primitives, asymmetric public-to-private overlay,
 * and situational persona anchoring.
 *
 * Designed as an SDK-agnostic domain core parameterized via `@rebecca/persona`
 * and Hexagonal storage/model ports so consuming services share unified cognition
 * without coupling to persistence SDKs, LLM clients, or specific delivery channels.
 */

export * from './types';
export * from './time';
export * from './workingMemory';
export * from './ragMemory';
export * from './compositeOverlay';
export * from './contextInjector';
export * from './evolution';
export * from './selfReflection';
export * from './dreaming';
export * from './personaAnchoring';
