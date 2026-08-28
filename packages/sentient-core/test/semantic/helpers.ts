/**
 * Shared helpers for the semantic engine test suite.
 */
import { SemanticKernel, resetSharedKernel, resetTinyalephLoader } from '../../src/semantic';

/**
 * Build a freshly loaded kernel. The ESM-only library is loaded for real via
 * the main-context loader (Jest's vm cannot handle bare `import()` without
 * --experimental-vm-modules; the loader falls back to Node's real loader).
 */
export async function freshKernel(): Promise<SemanticKernel> {
  resetSharedKernel();
  resetTinyalephLoader();
  const kernel = new SemanticKernel();
  await kernel.initialize();
  return kernel;
}
