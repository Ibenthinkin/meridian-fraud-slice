// Infrastructure tests. These need aws-cdk-lib installed (npm install), and
// run as part of `npm test`. They assert the properties a reviewer at a
// regulated firm would check, not the whole template.
import { App, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { beforeAll, describe, expect, it } from "vitest";
import { FraudSliceStack } from "../lib/fraud-slice-stack.js";

let template: Template;
let stack: FraudSliceStack;

beforeAll(() => {
  const app = new App();
  stack = new FraudSliceStack(app, "TestStack", { envName: "test" });
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  template = Template.fromStack(stack);
});

describe("data stores", () => {
  it("creates four on-demand tables with point-in-time recovery", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 4);
    template.allResourcesProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it("expires idempotency records with a TTL", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "idempotencyKey", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("lets investigators query decisions by account", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "byAccount" })]),
    });
  });

  it("encrypts, versions, and blocks public access on the lake", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
      BucketEncryption: Match.anyValue(),
    });
  });
});

describe("compute and routing", () => {
  it("runs the four service functions on Node 22 arm64", () => {
    // CDK adds its own helper functions (bucket auto-delete), so filter to ours.
    const ours = template.findResources("AWS::Lambda::Function", { Properties: { Architectures: ["arm64"] } }) as Record<string, { Properties: { Runtime: string } }>;
    expect(Object.keys(ours)).toHaveLength(4);
    for (const fn of Object.values(ours)) expect(fn.Properties.Runtime).toBe("nodejs22.x");
  });

  it("exposes one POST route for decisions", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /risk/decisions" });
  });

  it("routes only holds and blocks to the case queue", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({ detail: { action: ["hold", "block"] } }),
    });
  });

  it("gives the case queue a dead-letter queue", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it("reports partial batch failures from the case worker", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });
});

describe("least privilege", () => {
  it("never grants the decide function write access to the features table", () => {
    type Policy = { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } };
    const policies = template.findResources("AWS::IAM::Policy") as Record<string, Policy>;
    const decidePolicy = Object.entries(policies).find(([name]) => name.startsWith("DecideFnServiceRoleDefaultPolicy"));
    expect(decidePolicy).toBeDefined();
    const statements = decidePolicy![1].Properties.PolicyDocument.Statement;
    const writesToFeatures = statements.some((s) => {
      const actions = ([] as string[]).concat(s.Action);
      const resources = JSON.stringify(s.Resource);
      return actions.some((a) => /dynamodb:(Put|Update|Delete|BatchWrite)Item/.test(a)) && /Features/.test(resources);
    });
    expect(writesToFeatures).toBe(false);
  });
});

describe("policy as code", () => {
  it("passes the AWS Solutions rule pack with only explained exceptions", () => {
    const errors = Annotations.fromStack(stack).findError("*", Match.stringLikeRegexp("AwsSolutions-.*"));
    expect(errors.map((e) => e.entry.data)).toEqual([]);
  });
});
