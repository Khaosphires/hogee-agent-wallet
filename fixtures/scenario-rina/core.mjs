// Load the real shared core in plain Node scripts without copying its rules.
import { tsImport } from 'tsx/esm/api';
export const core = await tsImport('../../packages/core/src/index.ts', import.meta.url);
