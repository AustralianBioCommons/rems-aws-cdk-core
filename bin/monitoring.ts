#!/usr/bin/env node
import { App, Environment, Tags } from "aws-cdk-lib";
import { MonitoringObservabilityStack } from "../lib/monitoring-observability-stack";

// CENTRAL, one-off monitoring account resources: the AMP workspace + Grafana.
// Deploy this once against the monitoring account. Per-project workload-side
// observability (the ADOT/JMX SSM params and the OAM link) now lives in
// createRemsApp() and is deployed by each project's thin repo — not here.
const app = new App();

const monitoringEnv: Environment = {
  account: process.env.MONITORING_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.MONITORING_REGION      ?? process.env.CDK_DEFAULT_REGION ?? "ap-southeast-2",
};

Tags.of(app).add("Application", "Observability");
Tags.of(app).add("Owner", process.env.OWNER || "biocloud");

// AMP + Grafana (receives remote_write from every project's prod collector)
new MonitoringObservabilityStack(app, "Monitoring-Observability", { env: monitoringEnv });

/*
  Deploy:
    MONITORING_ACCOUNT_ID=<central-acct> \
    npx cdk deploy Monitoring-Observability \
      --app "npx ts-node --prefer-ts-exts bin/monitoring.ts"

  Then note the AmpWorkspaceId / AmpRemoteWriteEndpoint / OAM sink ARN outputs
  and put them in each project's config (ampWorkspaceId, monitoringAccountId,
  monitoringOamSinkId).
*/
