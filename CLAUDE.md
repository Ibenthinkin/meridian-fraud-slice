# Working in this repo (for people and for agents)

This is the fraud decisioning slice for Meridian Investments, a fictitious firm. It's a study project, but it's written to the standard a regulated firm would hold, so the rules below are real.

## What this code does

- `src/core/` is pure TypeScript: signals, rules, the model interface, and `decide()`. No AWS imports. Everything here must have unit tests.
- `src/handlers/` are thin Lambda handlers that wire `core` to DynamoDB, EventBridge, and S3.
- `lib/` is the CDK stack. `bin/app.ts` is the entry point and attaches cdk-nag.
- `src/core/rules.json` is policy. Changing it is a fraud-strategy decision, not an engineering one.

## Rules for changes

1. Run `npm run verify` (typecheck, tests, synth with cdk-nag) before opening a PR. A PR that doesn't pass it will not be reviewed.
2. Money is integer cents. Never introduce floating-point arithmetic on amounts.
3. Anything that creates or moves something must be idempotent. If you add an endpoint or a consumer, add the duplicate-delivery test with it.
4. Every decision must be explainable: a new rule needs an `id`, a `description`, and a test showing when it fires. A model may escalate to `hold`; only a rule may `block`.
5. New rules ship in shadow mode first (`"shadow": true`). Turning a rule live is a separate PR with the `rule-change` label.
6. Never log request bodies, headers, account numbers, or anything that could identify a client. Log ids and outcomes.
7. Don't add a dependency without saying why in the PR. Lockfile changes are reviewed line by line. If you're not certain a package exists and is maintained, don't add it.
8. Don't change files under `.github/`, `CLAUDE.md`, `AGENTS.md`, or `.claude/` in the same PR as a feature. Those need the `agent-config-change` label and a separate review.
9. Keep PRs small and single-purpose. One rule, one handler, one construct. A reviewer should be able to read the whole diff in ten minutes.
10. If you are an agent: say so in the PR description, list the commands you ran and their results, and never mark a PR ready for review or approve one.

## Useful commands

- `npm run verify`: the full local gate
- `npm run test:core`: just the pure logic tests
- `npm run synth`: CloudFormation template plus cdk-nag findings in `cdk.out/`
- `npm run diff`: what a deploy would change in the target account
- `npm run deploy` / `npm run destroy`: sandbox only; see README for cost notes
