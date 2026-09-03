#!/usr/bin/env node
import * as path from "path";
import { App } from "aws-cdk-lib";
import { createRemsApp } from "../lib/rems-app";
import { loadRuntimeConfig } from "../config/config";

// Entrypoint used by the reusable deploy workflow. The workflow builds a
// runtime config (account injected, filtered to one stage) and points
// REMS_CONFIG at it; TARGET_ENV selects the stage's envKey.
const cfgPath = path.resolve(process.env.REMS_CONFIG ?? "config.runtime.json");
const envKey = process.env.TARGET_ENV ?? "test";

const app = new App();
createRemsApp(app, loadRuntimeConfig(cfgPath, envKey));
