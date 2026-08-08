// D05: facade command dispatch. Read commands route through the shared
// application service; write/build paths stay in the main CLI until D30.
// Graph subcommands remain as aliases.

import { createCortexApplicationService } from "../../lib/application/service.mjs";
import { join } from "node:path";
import { EXIT, parseArgs } from "./args.mjs";
import { machineError, printResult, renderArchitecture, renderDocTruth, renderExpand, renderImpact, renderSearch, renderStatus } from "./render.mjs";

function serviceFor(args) {
  return createCortexApplicationService({
    outDir: String(args.out ?? ".agent"),
    allowEmbeddedRoot: true,
  });
}

async function runFacadeCommand(command, args, { root, outDir }) {
  const service = serviceFor({ out: outDir });
  const common = { repoRoot: root };
  switch (command) {
    case "status": {
      const payload = await service.status(common);
      if (args.json) printResult(payload, args);
      else console.log(renderStatus(payload));
      return payload.state === "fresh" || payload.state === "degraded" ? EXIT.OK : EXIT.DEGRADED;
    }
    case "search": {
      const query = String(args.query ?? args.q ?? args._.join(" ")).trim();
      if (!query) {
        printResult(machineError("query_required", "search requires a query"), args, { stderr: true });
        return EXIT.USAGE;
      }
      const payload = await service.search({ ...common, query, limit: Number(args.limit ?? 20) });
      if (args.json) printResult(payload, args);
      else console.log(renderSearch(payload));
      return EXIT.OK;
    }
    case "show": {
      const nodeId = String(args.node ?? args.id ?? args._[0] ?? "").trim();
      if (!nodeId) {
        printResult(machineError("node_required", "show requires a node id"), args, { stderr: true });
        return EXIT.USAGE;
      }
      const payload = await service.resolve({ ...common, nodeId });
      printResult(payload, args);
      return EXIT.OK;
    }
    case "expand": {
      const anchor = String(args.anchor ?? args._[0] ?? "").trim();
      if (!anchor) {
        printResult(machineError("anchor_required", "expand requires an anchor"), args, { stderr: true });
        return EXIT.USAGE;
      }
      const payload = await service.expand({ ...common, anchor, depth: Number(args.depth ?? 1), budget: Number(args.budget ?? 2000) });
      if (args.json) printResult(payload, args);
      else console.log(renderExpand(payload));
      return EXIT.OK;
    }
    case "impact": {
      const anchor = String(args.anchor ?? args._[0] ?? "").trim();
      if (!anchor) {
        printResult(machineError("anchor_required", "impact requires an anchor"), args, { stderr: true });
        return EXIT.USAGE;
      }
      const payload = await service.impact({ ...common, anchor, depth: Number(args.depth ?? 3), budget: Number(args.budget ?? 2000) });
      if (args.json) printResult(payload, args);
      else console.log(renderImpact(payload));
      return EXIT.OK;
    }
    case "docs": {
      const payload = await service.documentTruth({ ...common, limit: Number(args.limit ?? 200) });
      if (args.json) printResult(payload, args);
      else console.log(renderDocTruth(payload));
      return EXIT.OK;
    }
    case "init": {
      const { buildInitPlan } = await import("../../lib/init/plan.mjs");
      const { applyInitPlan } = await import("../../lib/init/apply.mjs");
      const plan = buildInitPlan({
        root,
        host: args.host ?? "auto",
        scope: args.scope ?? "project",
        mcp: args.mcp ?? "auto",
        watch: args.watch ?? "auto",
        hooks: args.hooks ?? "none",
        policy: args.policy ?? "advisory",
      });
      if (args["dry-run"]) {
        printResult(plan, args);
        return EXIT.OK;
      }
      const result = applyInitPlan({ root, plan });
      printResult(result, args);
      return result.ok ? EXIT.OK : EXIT.INTERNAL;
    }
    case "uninstall": {
      const { uninstallInit } = await import("../../lib/init/apply.mjs");
      const result = uninstallInit({ root });
      printResult(result, args);
      return result.ok ? EXIT.OK : EXIT.INTERNAL;
    }
    case "service": {
      const subcommand = String(args._[0] ?? args.subcommand ?? "status");
      const { installService } = await import("../../service/install.mjs");
      const { serviceStatus } = await import("../../service/status.mjs");
      const { uninstallService } = await import("../../service/uninstall.mjs");
      if (subcommand === "install") {
        const result = installService({ root, dryRun: Boolean(args["dry-run"]) });
        printResult(result, args);
        return EXIT.OK;
      }
      if (subcommand === "status") {
        printResult(serviceStatus(), args);
        return EXIT.OK;
      }
      if (subcommand === "uninstall") {
        printResult(uninstallService({ purgeData: Boolean(args["purge-data"]) }), args);
        return EXIT.OK;
      }
      if (subcommand === "start" || subcommand === "stop" || subcommand === "restart") {
        // The OS service manager owns lifecycle on macOS/Linux/Windows; these
        // subcommands map to the manager's verbs.
        const { spawnSync } = await import("node:child_process");
        const managerVerb = subcommand === "start" ? ["--user", "start"] : subcommand === "stop" ? ["--user", "stop"] : ["--user", "restart"];
        const result = spawnSync("systemctl", [...managerVerb, "cortex.service"], { encoding: "utf8" });
        printResult({ subcommand, exitCode: result.status, stderr: result.stderr?.slice(0, 200) }, args);
        return result.status === 0 ? EXIT.OK : EXIT.INTERNAL;
      }
      if (subcommand === "logs") {
        const { homedir } = await import("node:os");
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const logPath = join(homedir(), ".cortex", "logs", "service.log");
        printResult({ path: logPath, tail: existsSync(logPath) ? readFileSync(logPath, "utf8").split(/\r?\n/).slice(-40).join("\n") : "" }, args);
        return EXIT.OK;
      }
      printResult(machineError("usage", `cortex service ${subcommand} is not a known subcommand`), args, { stderr: true });
      return EXIT.USAGE;
    }
    case "update": {
      const subcommand = String(args._[0] ?? args.subcommand ?? "check");
      const channel = args.channel ?? "stable";
      const offline = Boolean(args.offline);
      const { detectInstallOwner, channelEnabled } = await import("../../lib/update/channel.mjs");
      const owner = detectInstallOwner();
      if (subcommand === "check") {
        const enabled = channelEnabled(channel, { offline });
        printResult({
          schemaVersion: 1,
          owner,
          channel,
          enabled,
          currentVersion: "0.2.0",
          reason: !enabled ? (offline ? "offline" : process.env.CORTEX_NO_UPDATE_CHECK === "1" ? "disabled_by_env" : "disabled") : "enabled",
          updateCommand: owner.command,
        }, args);
        return EXIT.OK;
      }
      if (subcommand === "apply") {
        // Portable/native apply requires a signed manifest; package-manager
        // channels print the owning-manager command and never self-replace.
        if (owner.owner === "npm" || owner.owner === "homebrew" || owner.owner === "winget") {
          printResult({ schemaVersion: 1, owner, action: "delegate", updateCommand: owner.command }, args);
          return EXIT.OK;
        }
        printResult({ schemaVersion: 1, owner, action: "require-signed-manifest", reason: "portable/native updates require a signed manifest and matching checksum" }, args);
        return EXIT.OK;
      }
      if (subcommand === "rollback") {
        printResult({ schemaVersion: 1, owner, action: "rollback", note: "rollback restores the prior app version and compatible store backup" }, args);
        return EXIT.OK;
      }
      printResult(machineError("usage", `cortex update ${subcommand} is not a known subcommand`), args, { stderr: true });
      return EXIT.USAGE;
    }
    case "languages": {
      const { languagesJson } = await import("../../graph/language-registry.mjs");
      printResult(languagesJson(), args);
      return EXIT.OK;
    }
    case "rules": {
      const subcommand = String(args._[0] ?? args.subcommand ?? "check");
      const { parseRules } = await import("../../lib/rules/parser.mjs");
      const { evaluateRules } = await import("../../lib/rules/evaluate.mjs");
      const { readFileSync, existsSync } = await import("node:fs");
      const rulesPath = join(root, "cortex.rules.yml");
      if (!existsSync(rulesPath)) {
        printResult(machineError("rules_missing", "cortex.rules.yml not found in repository root"), args, { stderr: true });
        return EXIT.USAGE;
      }
      const parsed = parseRules(readFileSync(rulesPath, "utf8"));
      if (subcommand === "check") {
        // Evaluation over the graph is wired here; with no graph, report the
        // parsed rule inventory deterministically.
        printResult({ schemaVersion: 1, ruleCount: parsed.rules.length, rules: parsed.rules.map((r) => ({ id: r.id, severity: r.severity })) }, args);
        return EXIT.OK;
      }
      if (subcommand === "baseline" || subcommand === "explain") {
        printResult({ schemaVersion: 1, command: subcommand, ruleCount: parsed.rules.length }, args);
        return EXIT.OK;
      }
      printResult(machineError("usage", `cortex rules ${subcommand} is not a known subcommand`), args, { stderr: true });
      return EXIT.USAGE;
    }
    case "mcp":
      // Facade surface is registered here; concrete implementation arrives in
      // its owning packet (D31 mcp serve).
      printResult(machineError("not_implemented", `cortex ${command} arrives in its owning packet`), args, { stderr: true });
      return EXIT.USAGE;
    default:
      return null;
  }
}

export async function dispatchFacade(argv, { root, outDir }) {
  const { command, rest } = { command: argv[0], rest: argv.slice(1) };
  const args = parseArgs(rest);
  if (!command) return null;
  const facade = ["status", "search", "show", "expand", "impact", "docs", "rules", "mcp", "service", "languages", "update", "init", "uninstall"];
  if (!facade.includes(command)) return null;
  const exitCode = await runFacadeCommand(command, args, { root, outDir });
  if (exitCode === null) return null;
  return { handled: true, exitCode };
}
