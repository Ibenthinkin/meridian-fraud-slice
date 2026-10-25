#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { FraudSliceStack } from "../lib/fraud-slice-stack.js";

const app = new App();
const envName = app.node.tryGetContext("env") ?? "sandbox";

new FraudSliceStack(app, `MeridianFraud-${envName}`, {
  envName,
  // Env-agnostic on purpose: deploys to whatever account/region your credentials point at.
  description: "Meridian Investments fraud decisioning slice (synthetic data, sandbox)",
});

// Policy as code. Every synth runs the AWS Solutions rule pack; findings fail
// the build unless they carry an explained suppression in the stack.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
