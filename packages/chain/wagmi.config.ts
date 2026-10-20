/**
 * ABI codegen (project.md §26.9): only the four frozen interfaces, nothing from tests or dependencies.
 * Run `pnpm --filter @hogee/chain abi:generate`; CI runs `abi:check` to catch drift.
 */
import { defineConfig } from '@wagmi/cli';
import { foundry } from '@wagmi/cli/plugins';

const INTERFACES = ['IPlanRegistry', 'ITreasury', 'IMilestoneEscrow', 'ISalesOracle'] as const;

export default defineConfig({
  out: 'src/generated.ts',
  plugins: [
    foundry({
      project: '../../contracts',
      include: INTERFACES.map((name) => `IHogee.sol/${name}.json`),
      // The abi:generate script runs `forge build` first; the plugin only reads artifacts.
      forge: { build: false, rebuild: false },
    }),
  ],
});
