/**
 * rems-aws-cdk — shared REMS-on-AWS engine.
 *
 * Thin per-project deployment repos import from here:
 *
 *   import { App } from "aws-cdk-lib";
 *   import { createRemsApp, getConfigFromEnv } from "rems-aws-cdk-core";
 *
 *   const app = new App();
 *   createRemsApp(app, getConfigFromEnv());
 */

// Primary entrypoint most consumers need.
export { createRemsApp, RemsAppStacks } from "./lib/rems-app";

// Config type + loaders/helpers.
export {
  Config,
  RawConfig,
  getConfig,
  getConfigFromEnv,
  getConfigFromFile,
  configFromJson,
  getPostgresEngineVersion,
  getDBInstanceSize,
  getDBInstanceClass,
} from "./config/config";

// Individual stacks, exported for advanced/opt-in composition.
export { NetworkStack } from "./lib/network-stack";
export { DatabaseStack } from "./lib/database-stack";
export { ComputeStack } from "./lib/compute-stack";
export { WafStack } from "./lib/waf-stack";
export { RemsMigrationTask } from "./lib/rems-migration-task";
export { RemsAdminPsqlTaskStack } from "./lib/rems-admin-psql-task-stack";
