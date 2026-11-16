/**
 * @rebecca/memory
 *
 * Pure cognitive memory engine covering Tatemae/Honne working memory & turn reconstruction,
 * core vectorization and RAG retrieval primitives, Layer 1 Global Evolution,
 * Layer 2 Self-Reflection, Layer 3 Dreaming consolidation, and one-way asymmetric overlay.
 *
 * Depends strictly on `@rebecca/types` with zero dependencies on persona templates,
 * prompt builders, persistence SDKs, or LLM clients.
 */

export * from './types';
export * from './workingMemory';
export * from './ragMemory';
export * from './compositeOverlay';
export * from './evolution';
export * from './selfReflection';
export * from './dreaming';
