/**
 * Proves the factory extraction is template-identical to the original
 * bin/rems_aws.ts wiring. Synthesizes both apps against the SAME dummy config
 * and diffs the CloudFormation template of every stack. Any difference = the
 * extraction would NOT be empty-diff.
 *
 * Run: npx ts-node scripts/verify_empty_diff.ts
 */
import { App, Environment, Tags } from "aws-cdk-lib";
import { Config, getConfigFromEnv } from "../config/config";
import { NetworkStack } from "../lib/network-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ComputeStack } from "../lib/compute-stack";
import { RemsMigrationTask } from "../lib/rems-migration-task";
import { WafStack } from "../lib/waf-stack";
import { RemsAdminPsqlTaskStack } from "../lib/rems-admin-psql-task-stack";
import { createRemsApp } from "../lib/rems-app";

const DUMMY_ACCOUNT = "111111111111";
const DUMMY_REGION = "ap-southeast-2";

// Seed the hosted-zone lookup so synth is fully offline & deterministic.
const context = {
  [`hosted-zone:account=${DUMMY_ACCOUNT}:domainName=example.org:region=${DUMMY_REGION}`]: {
    Id: "/hostedzone/DUMMY",
    Name: "example.org.",
  },
};

function dummyConfig(): Config {
  const c = getConfigFromEnv();
  c.accountId = DUMMY_ACCOUNT;
  c.region = DUMMY_REGION;
  c.hostZone = "example.org";
  c.deployEnvironment = "dev";
  c.project = "ACDC";
  c.owner = "biocloud";
  // Complete ARNs need a real 6-char suffix for fromSecretCompleteArn().
  const arn = (name: string) =>
    `arn:aws:secretsmanager:${DUMMY_REGION}:${DUMMY_ACCOUNT}:secret:${name}-abc123`;
  c.oidcClientSecretArn = arn("rems-oidc-client-secret");
  c.remsTokenSecretArn = arn("rems-token-secret");
  c.webhookSecretArn = arn("rems/webhook-secret");
  c.certificateArn = `arn:aws:acm:${DUMMY_REGION}:${DUMMY_ACCOUNT}:certificate/00000000-0000-0000-0000-000000000000`;
  return c;
}

/** The ORIGINAL bin/rems_aws.ts wiring, reproduced verbatim. */
function originalApp(): App {
  const app = new App({ context });
  const config = dummyConfig();
  const env: Environment = { account: config.accountId, region: config.region };

  Tags.of(app).add("Project", process.env.PROJECT || "ACDC");
  Tags.of(app).add("Environment", process.env.DEPLOY_ENV || "dev");
  Tags.of(app).add("Application", "REMS");
  Tags.of(app).add("Owner", process.env.OWNER || "biocloud");

  const networkStack = new NetworkStack(app, "REMS-NetworkStack", { env, config });
  const wafStack = new WafStack(app, "REMS-WafStack", { env, config });
  const databaseStack = new DatabaseStack(app, "REMS-DatabaseStack", { env, vpc: networkStack.vpc, config });
  const computeStack = new ComputeStack(app, `REMS-ComputeStack-${config.deployEnvironment}`, { env, vpc: networkStack.vpc, config });
  computeStack.addDependency(databaseStack);
  computeStack.addDependency(wafStack);
  const remsMigrationStack = new RemsMigrationTask(app, `REMS-MigrationTask-${config.deployEnvironment}`, { cluster: computeStack.cluster, vpc: networkStack.vpc, containerImage: config.containerImage, config, env });
  remsMigrationStack.addDependency(databaseStack);
  new RemsAdminPsqlTaskStack(app, `Rems-Admin-Sql-Tasks-${config.deployEnvironment}`, { env });
  return app;
}

/** The NEW wiring via the extracted factory. */
function factoryApp(): App {
  const app = new App({ context });
  createRemsApp(app, dummyConfig());
  return app;
}

const a = originalApp().synth();
const b = factoryApp().synth();

const namesA = a.stacks.map((s) => s.stackName).sort();
const namesB = b.stacks.map((s) => s.stackName).sort();

let mismatches = 0;
if (JSON.stringify(namesA) !== JSON.stringify(namesB)) {
  console.log("STACK SET DIFFERS:\n  original:", namesA, "\n  factory :", namesB);
  mismatches++;
}

for (const name of namesA) {
  const sa = a.getStackByName(name);
  const sb = b.getStackByName(name);
  const ta = JSON.stringify(sa.template);
  const tb = JSON.stringify(sb.template);
  if (ta === tb) {
    console.log(`  ✔ ${name}: template identical`);
  } else {
    console.log(`  �’ ${name}: TEMPLATE DIFFERS (len ${ta.length} vs ${tb.length})`);
    mismatches++;
  }
}

console.log(mismatches === 0
  ? "\nRESULT: all stacks template-identical — extraction is empty-diff."
  : `\nRESULT: ${mismatches} mismatch(es) — NOT empty-diff.`);
process.exit(mismatches === 0 ? 0 : 1);
