import { App, Environment, Tags } from "aws-cdk-lib";
import { Config } from "../config/config";
import { NetworkStack } from "./network-stack";
import { DatabaseStack } from "./database-stack";
import { ComputeStack } from "./compute-stack";
import { RemsMigrationTask } from "./rems-migration-task";
import { WafStack } from "./waf-stack";
import { RemsAdminPsqlTaskStack } from "./rems-admin-psql-task-stack";
import { RemsObservabilityParamsStack } from "./rems-observability-params-stack";
import { MonitoringOamSinkStack } from "./monitoring-oam-sink-stack";

/** Handles to every stack the REMS app creates, for callers that need them. */
export interface RemsAppStacks {
  networkStack: NetworkStack;
  wafStack: WafStack;
  databaseStack: DatabaseStack;
  computeStack: ComputeStack;
  remsMigrationStack: RemsMigrationTask;
  adminTask: RemsAdminPsqlTaskStack;
  /** Present only when observability is enabled (prod). */
  observabilityParams?: RemsObservabilityParamsStack;
  /** Present only when observability is enabled (prod) and an OAM sink is configured. */
  oamLink?: MonitoringOamSinkStack;
}

/**
 * Instantiate the full REMS stack set on the given App.
 *
 * EMPTY-DIFF CONTRACT
 * -------------------
 * Stacks are created directly on `app` with the SAME construct IDs as the
 * original bin/rems_aws.ts. CDK derives logical IDs from the construct path,
 * so keeping the IDs and the (flat, un-nested) tree identical means the
 * synthesized templates are byte-identical to the pre-extraction app. That is
 * what lets existing deployments (e.g. ACDC) adopt this factory with an empty
 * `cdk diff`.
 *
 * Do NOT, for existing deployments:
 *   - change any of the stack id strings below,
 *   - wrap these stacks in an intermediate Stage/Construct scope, or
 *   - change the app-level tag keys/values,
 * or CloudFormation will treat the resources as new (replacement = outage).
 *
 * New projects deploy into their OWN AWS account, so the identical stack and
 * physical names never collide with ACDC — the account boundary is the
 * isolation. No per-project name prefixing is required.
 */
export function createRemsApp(app: App, config: Config): RemsAppStacks {
  const env: Environment = {
    account: config.accountId,
    region: config.region,
  };

  // App-level tags — identical values to the original bin entrypoint.
  Tags.of(app).add("Project", config.project ?? "ACDC");
  Tags.of(app).add("Environment", config.deployEnvironment);
  Tags.of(app).add("Application", "REMS");
  Tags.of(app).add("Owner", config.owner ?? "biocloud");

  const networkStack = new NetworkStack(app, "REMS-NetworkStack", { env, config });
  const wafStack = new WafStack(app, "REMS-WafStack", { env, config });

  const databaseStack = new DatabaseStack(app, "REMS-DatabaseStack", {
    env,
    vpc: networkStack.vpc,
    config,
  });

  const computeStack = new ComputeStack(
    app,
    `REMS-ComputeStack-${config.deployEnvironment}`,
    {
      env,
      vpc: networkStack.vpc,
      config,
    }
  );

  computeStack.addDependency(databaseStack);
  computeStack.addDependency(wafStack);

  const remsMigrationStack = new RemsMigrationTask(
    app,
    `REMS-MigrationTask-${config.deployEnvironment}`,
    {
      cluster: computeStack.cluster,
      vpc: networkStack.vpc,
      containerImage: config.containerImage,
      config,
      env,
    }
  );

  remsMigrationStack.addDependency(databaseStack);

  const adminTask = new RemsAdminPsqlTaskStack(
    app,
    `Rems-Admin-Sql-Tasks-${config.deployEnvironment}`,
    { env }
  );

  // --- Workload-side observability -----------------------------------------
  // These live in the SAME (workload) account as the app, so a thin repo that
  // calls createRemsApp deploys them itself — no separate monitoring app.
  // Gated on prod, matching the ADOT collector in ComputeStack. The central
  // AMP + Grafana workspace is a one-off and stays in bin/monitoring.ts.
  const isProd =
    config.deployEnvironment === "prod" || config.deployEnvironment === "production";

  let observabilityParams: RemsObservabilityParamsStack | undefined;
  let oamLink: MonitoringOamSinkStack | undefined;

  if (isProd) {
    observabilityParams = new RemsObservabilityParamsStack(
      app,
      `Rems-Observability-Params-${config.deployEnvironment}`,
      { env, deployEnvironment: config.deployEnvironment }
    );
    // ComputeStack reads the ADOT/JMX SSM params this stack writes.
    computeStack.addDependency(observabilityParams);

    if (config.monitoringOamSinkId) {
      oamLink = new MonitoringOamSinkStack(
        app,
        `Rems-OAM-Link-${config.deployEnvironment}`,
        {
          env,
          sinkIdentifier: config.monitoringOamSinkId,
          project: config.project ?? "rems",
          deployEnvironment: config.deployEnvironment,
        }
      );
    }
  }

  return {
    networkStack,
    wafStack,
    databaseStack,
    computeStack,
    remsMigrationStack,
    adminTask,
    observabilityParams,
    oamLink,
  };
}
