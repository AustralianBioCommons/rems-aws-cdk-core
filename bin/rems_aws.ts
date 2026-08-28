#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { getConfigFromEnv } from "../config/config";
import { createRemsApp } from "../lib/rems-app";

// Standalone entrypoint for the core repo itself. Thin per-project repos have
// their own equivalent bin/ that pins this package and calls createRemsApp().
const app = new App();
const config = getConfigFromEnv();
createRemsApp(app, config);
