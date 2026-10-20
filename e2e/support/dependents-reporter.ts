/**
 * Says which dependent project did not run (P1 re-review of #6, nit 7a). "after-reset" depends on both viewport
 * projects, because it resets the shared mock store. When one of them fails, Playwright skips it and the list reporter
 * only adds an anonymous "N did not run", so the after-reset coverage disappears without a word.
 */
import type { FullConfig, FullResult, Reporter, Suite } from "@playwright/test/reporter";

export default class DependentsReporter implements Reporter {
  private config?: FullConfig;
  private root?: Suite;

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.root = suite;
  }

  onEnd(_result: FullResult): void {
    const dependsOn = new Map((this.config?.projects ?? []).map((p) => [p.name, p.dependencies]));
    const notRun = new Map<string, number>();
    for (const test of this.root?.allTests() ?? []) {
      const project = test.parent.project()?.name ?? "";
      if (test.results.length === 0 && (dependsOn.get(project)?.length ?? 0) > 0) notRun.set(project, (notRun.get(project) ?? 0) + 1);
    }
    for (const [project, count] of notRun) {
      const deps = dependsOn.get(project)?.join(", ") ?? "";
      const text = `Project "${project}" did not run (${count} test${count === 1 ? "" : "s"}): a project it depends on (${deps}) failed or was interrupted. Fix that first, or run it alone with --project=${project} --no-deps.`;
      process.stderr.write(`${process.env.GITHUB_ACTIONS ? "::error::" : "\n"}${text}\n`);
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
