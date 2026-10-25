# Meridian Fraud Slice

A deployable slice of the fraud decisioning platform for **Meridian Investments**, a fictitious firm shaped like a large US investment company. Built with AWS CDK in TypeScript. Synthetic data only.

It's the working half of a case study: the architecture document explains the whole firm; this repo is the piece you can stand up in a sandbox account, poke at, and tear down for about a dollar.

```
                 fast path (client waiting)                     learning path (after the fact)

 money movement ──POST /risk/decisions──▶ decide λ ──▶ DynamoDB:  features ◀── ingest λ ◀── domain events
 identity                                     │        idempotency                         (login, contact change,
                                              │        decisions                            payee added, withdrawal)
                                              └──▶ EventBridge bus ──┬──▶ SQS ──▶ case worker λ ──▶ cases   (hold/block)
                                                                     └──▶ archive λ ──▶ S3 lake            (everything)
```

## What's in it

| Path | What it is |
| --- | --- |
| `src/core/` | Pure TypeScript decision logic: signals, a versioned rules engine, a model interface with a heuristic stand-in, and `decide()`. No AWS imports, fully unit tested. |
| `src/core/rules.json` | The rule set. Versioned, validated on load, supports shadow mode. |
| `src/handlers/` | Four Lambda handlers: the decision API, the feature ingester, the case worker, and the archiver. |
| `lib/fraud-slice-stack.ts` | The CDK stack: four DynamoDB tables, an event bus, an HTTP API, an SQS queue with a DLQ, an S3 lake, alarms, and least-privilege grants. |
| `bin/app.ts` | Entry point. Attaches cdk-nag so every synth is also a policy check. |
| `test/core.test.ts` | Logic tests: the takeover sequence, shadow rules, degraded modes, idempotent feature replay. |
| `test/stack.test.ts` | Infrastructure tests: the properties a reviewer at a regulated firm would check. |
| `scripts/seed.ts`, `scripts/demo.ts` | Build a client's history, then walk the classic account-takeover sequence against the live API. |
| `.github/workflows/ci.yml`, `CODEOWNERS`, `CLAUDE.md` | The CI/CD half of the case study: gates every PR goes through, and the rules agents work under. |
| `docs/cloudformation-notes.md` | How each construct maps to CloudFormation, and how you'd do the same thing without CDK. |

## Run it

You need Node 22, an AWS account you're happy to experiment in, and credentials in your shell (`aws sts get-caller-identity` should work).

```bash
npm install
npm run verify          # typecheck, unit + infra tests, synth with cdk-nag
npx cdk bootstrap       # once per account/region
npm run deploy          # writes cdk-outputs.json
npm run seed            # publish two years of history for a demo client
npm run demo            # the takeover sequence, live
npm run destroy         # when you're done
```

`npm run demo` prints something like:

```
ALLOW    Dana withdraws $1,950 to her usual bank from her laptop
STEP_UP  Login from a brand-new device
STEP_UP  Change contact info from the new device
STEP_UP  Add a new linked bank account
HOLD     Withdraw $24,000 to the bank account added minutes ago
         reasons: NEW_DEVICE_MONEY, PAYEE_UNDER_3D, CONTACT_CHANGED_7D, AMOUNT_10X_TYPICAL, MODEL_SCORE_HOLD
HOLD     Same request retried with the same idempotency key   (replayed)
409      Same idempotency key, different amount
STEP_UP  Dana's own normal withdrawal from her phone, after all that
HOLD     Withdrawal for an account the feature store has never seen   (degraded)
```

Then look at the `Cases` table (the held decisions became cases) and the lake bucket (every event, partitioned by date).

## What it costs

Everything is serverless and on-demand, so an idle stack costs nothing and the demo costs cents. Rough numbers for a week of poking at it: well under $1, and $0 on a Free-plan account. The things that *would* cost real money are deliberately absent: no NAT gateway, no provisioned concurrency, no SageMaker endpoint, no Kinesis shards, no DAX. If you add any of those to experiment, destroy the stack when you're done. Set an AWS Budgets alert either way.

## Design choices worth being able to defend

- **Synchronous decision, asynchronous everything else.** The client waits only for the decision. Cases, the lake, and notifications hang off the decision event.
- **Rules and a model together.** Rules are explainable and fast to change; the model catches combinations nobody wrote a rule for. A model score can escalate as far as `hold`. Only a rule can `block`, because a block needs a reason a person can state.
- **Idempotency on the decision, not just on the payment.** Same key, same answer, no second case. Same key with a different payload is rejected.
- **A degraded policy decided ahead of time.** If history can't be loaded, logins step up and withdrawals hold. Nobody decides that during an outage.
- **Shadow mode for new rules.** A rule can be evaluated and logged without changing the action, so you can see its hit rate before it touches anyone's money.
- **Features are rebuilt from events.** `applyEvent` is pure, so the feature store can be replayed from the lake after a bug or a schema change.
- **Least privilege you can test.** `test/stack.test.ts` asserts the decision function can't write to the features table.
- **Policy as code.** cdk-nag runs on every synth. Every exception is in `lib/` with a reason, where a reviewer sees it.

## What a real version adds

This slice stops where the demo stops. The case study document covers the rest; the short list is: IAM auth between services (the API is open so the demo can call it), a real model behind a SageMaker endpoint, Kinesis or Kafka plus Flink for velocity features at scale, Firehose into Parquet for the lake, Object Lock for records retention, multi-account deployment through CDK Pipelines, access logging on the API, and a case-management system worth the name.

## CloudFormation

If your team writes CloudFormation rather than CDK, `docs/cloudformation-notes.md` maps every construct here to its resource types and shows how to read the template `cdk synth` produces. `cdk.out/MeridianFraud-sandbox.template.json` is plain CloudFormation; you could deploy it with the console and never touch CDK again.
