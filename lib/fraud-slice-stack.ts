import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const handlers = path.join(here, "..", "src", "handlers");

export interface FraudSliceStackProps extends StackProps {
  /** Short environment name used in resource names and tags, e.g. "sandbox". */
  envName: string;
}

/**
 * The Fraud Decisioning slice of Meridian Investments (a fictitious firm).
 *
 * Fast path (client waiting):   HTTP API -> decide Lambda -> DynamoDB (features, idempotency, decisions) -> EventBridge
 * Learning path (after the fact): EventBridge -> ingest Lambda -> features table
 *                                 EventBridge -> SQS -> case worker -> cases table (hold/block only)
 *                                 EventBridge -> archive Lambda -> S3 data lake (everything)
 */
export class FraudSliceStack extends Stack {
  constructor(scope: Construct, id: string, props: FraudSliceStackProps) {
    super(scope, id, props);
    const { envName } = props;
    Tags.of(this).add("app", "meridian-fraud-slice");
    Tags.of(this).add("env", envName);
    Tags.of(this).add("data-classification", "synthetic");

    // ------------------------------------------------------------------ data
    // On-demand billing: nothing to size, nothing to pay for while idle.
    const features = new dynamodb.Table(this, "Features", {
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const decisions = new dynamodb.Table(this, "Decisions", {
      partitionKey: { name: "decisionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // "Show me every decision for this account" is the investigator's first question.
    decisions.addGlobalSecondaryIndex({
      indexName: "byAccount",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "decidedAt", type: dynamodb.AttributeType.STRING },
    });

    const idempotency = new dynamodb.Table(this, "Idempotency", {
      partitionKey: { name: "idempotencyKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const cases = new dynamodb.Table(this, "Cases", {
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const accessLogs = new s3.Bucket(this, "LakeAccessLogs", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const lake = new s3.Bucket(this, "Lake", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: "lake/",
      lifecycleRules: [{ transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) }] }],
      // Sandbox only. A real lake is RETAIN with Object Lock for the records retention rules.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --------------------------------------------------------------- events
    const bus = new events.EventBus(this, "Bus", { eventBusName: `meridian-fraud-${envName}` });

    // ------------------------------------------------------------- functions
    const fn = (name: string, entry: string, env: Record<string, string>, extra: Partial<lambda.FunctionProps> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(handlers, entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(10),
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
        environment: { NODE_OPTIONS: "--enable-source-maps", ...env },
        bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: "node22" },
        ...extra,
      });

    const decide = fn("DecideFn", "decide.ts", {
      FEATURES_TABLE: features.tableName,
      DECISIONS_TABLE: decisions.tableName,
      IDEMPOTENCY_TABLE: idempotency.tableName,
      EVENT_BUS_NAME: bus.eventBusName,
      FEATURE_TIMEOUT_MS: "150",
    });
    features.grantReadData(decide);
    decisions.grantWriteData(decide);
    idempotency.grantReadWriteData(decide);
    bus.grantPutEventsTo(decide);

    const ingest = fn("IngestFn", "ingest.ts", { FEATURES_TABLE: features.tableName });
    features.grantReadWriteData(ingest);

    const caseWorker = fn("CaseWorkerFn", "case-worker.ts", { CASES_TABLE: cases.tableName }, { timeout: Duration.seconds(30) });
    cases.grantWriteData(caseWorker);

    const archive = fn("ArchiveFn", "archive.ts", { LAKE_BUCKET: lake.bucketName });
    lake.grantPut(archive);

    // ------------------------------------------------------------------ API
    const api = new apigwv2.HttpApi(this, "Api", {
      apiName: `meridian-fraud-${envName}`,
      description: "Synchronous fraud decisions for Meridian's client-facing services",
    });
    api.addRoutes({
      path: "/risk/decisions",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("DecideIntegration", decide),
    });

    // ----------------------------------------------------------- routing
    // Domain events from the rest of the firm feed the feature store.
    new events.Rule(this, "DomainEventsToIngest", {
      eventBus: bus,
      eventPattern: { source: ["identity", "servicing", "money", "accounts"] },
      targets: [new targets.LambdaFunction(ingest, { retryAttempts: 2 })],
    });

    // Decisions that need a person go to a queue, so case management can be
    // slow or down without anyone noticing on the client side.
    const caseDlq = new sqs.Queue(this, "CaseDlq", { enforceSSL: true, retentionPeriod: Duration.days(14) });
    const caseQueue = new sqs.Queue(this, "CaseQueue", {
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(6 * 30), // 6x the worker timeout, per AWS guidance
      deadLetterQueue: { queue: caseDlq, maxReceiveCount: 3 },
    });
    new events.Rule(this, "HoldsToCaseQueue", {
      eventBus: bus,
      eventPattern: { source: ["fraud.decisions"], detailType: ["fraud.decision"], detail: { action: ["hold", "block"] } },
      targets: [new targets.SqsQueue(caseQueue)],
    });
    caseWorker.addEventSource(new SqsEventSource(caseQueue, { batchSize: 10, reportBatchItemFailures: true }));

    // Everything on the bus is archived for training, audit, and replay.
    new events.Rule(this, "AllEventsToLake", {
      eventBus: bus,
      eventPattern: { source: events.Match.prefix("") },
      targets: [new targets.LambdaFunction(archive, { retryAttempts: 2 })],
    });

    // ------------------------------------------------------------ alarms
    // What a fraud team watches: the API failing, work piling up unprocessed,
    // and (the subtle one) the mix of actions changing suddenly.
    new cloudwatch.Alarm(this, "ApiServerErrors", {
      metric: api.metricServerError({ period: Duration.minutes(5), statistic: "sum" }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: "Decision API returning 5xx. Clients can't get decisions.",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "CaseDlqNotEmpty", {
      metric: caseDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: "max" }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "Held decisions failed to become cases three times. Someone must look.",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "DecideP99Latency", {
      metric: decide.metricDuration({ period: Duration.minutes(5), statistic: "p99" }),
      threshold: 800,
      evaluationPeriods: 2,
      alarmDescription: "Decision p99 above 800ms. Clients feel the tail, not the average.",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ----------------------------------------------------------- outputs
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint, description: "POST /risk/decisions" });
    new CfnOutput(this, "EventBusName", { value: bus.eventBusName });
    new CfnOutput(this, "FeaturesTableName", { value: features.tableName });
    new CfnOutput(this, "DecisionsTableName", { value: decisions.tableName });
    new CfnOutput(this, "CasesTableName", { value: cases.tableName });
    new CfnOutput(this, "LakeBucketName", { value: lake.bucketName });

    // ------------------------------------------------- policy exceptions
    // cdk-nag flags what a regulated firm would question. Each exception is
    // explicit and explained, the way a reviewer would want to see it.
    NagSuppressions.addResourceSuppressions(accessLogs, [
      { id: "AwsSolutions-S1", reason: "The access-logs bucket does not log to itself." },
    ]);
    NagSuppressions.addResourceSuppressions(caseDlq, [
      { id: "AwsSolutions-SQS3", reason: "This queue is the dead-letter queue; it has an alarm instead of another DLQ." },
    ]);
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason: "AWSLambdaBasicExecutionRole is the standard managed policy for Lambda logging.",
        appliesTo: ["Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
      },
      {
        id: "AwsSolutions-IAM5",
        reason: "Wildcards come from CDK grant helpers and are scoped to this stack's own tables (index ARNs), bucket (object keys), and the bucket auto-delete custom resource. Review `cdk synth` output to confirm no `Resource: *` on a data action.",
      },
      { id: "AwsSolutions-APIG1", reason: "HTTP API access logging needs a stage override; the sandbox relies on Lambda structured logs. Enable before anything non-synthetic." },
      { id: "AwsSolutions-APIG4", reason: "Sandbox API is unauthenticated on purpose so the demo script can call it. Production uses IAM auth between internal services." },
      { id: "AwsSolutions-L1", reason: "Runtime is pinned to Node.js 22 deliberately; the latest-runtime rule lags new releases and CDK's own custom-resource functions pick their own runtime." },
    ]);
  }
}
