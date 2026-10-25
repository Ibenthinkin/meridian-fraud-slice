# CloudFormation notes

Vanguard postings mention CloudFormation; this project is CDK. They're the same thing underneath: CDK is a program that writes CloudFormation templates. This note is for talking to a CloudFormation team in their language.

## How they relate

| CDK | CloudFormation |
| --- | --- |
| `cdk synth` | Produces the template (`cdk.out/*.template.json`) plus assets (zipped Lambda code, uploaded to the bootstrap bucket). |
| `cdk diff` | A diff of the new template against the deployed stack's template, with IAM and security-group changes called out. CloudFormation's own version is a **change set**. |
| `cdk deploy` | Creates a change set and executes it. Rollback, drift detection, stack policies, and the events log are all CloudFormation's. |
| `cdk bootstrap` | Creates the bootstrap stack: an S3 bucket for assets, an ECR repo, and the deploy roles. The CloudFormation execution role is **admin by default**; a regulated firm overrides it with `--cloudformation-execution-policies` or a custom bootstrap template and adds a permission boundary. |
| L2 constructs (`new dynamodb.Table(...)`) | Opinionated wrappers that expand to one or more resources with safe defaults. `table.grantReadData(fn)` writes the IAM policy statement for you. |
| L1 constructs (`CfnTable`) | One-to-one with a CloudFormation resource type. Same properties, same names. |
| `Aspects` + cdk-nag | No native equivalent at synth time. The CloudFormation-side equivalents are **CloudFormation Hooks** (proactive, block a bad template at deploy), **AWS Config rules** (detective, flag drift after), and **SCPs** (preventive, at the org boundary). |

## What this stack becomes

Run `npm run synth` and open `cdk.out/MeridianFraud-sandbox.template.json`. You'll find roughly 50 resources. The ones that matter:

| In `lib/fraud-slice-stack.ts` | CloudFormation resource types |
| --- | --- |
| `new dynamodb.Table(...)` ×4 | `AWS::DynamoDB::Table` |
| `new events.EventBus(...)` | `AWS::Events::EventBus` |
| `new events.Rule(...)` ×3 | `AWS::Events::Rule`, plus `AWS::Lambda::Permission` (so EventBridge may invoke) and `AWS::SQS::QueuePolicy` (so it may send) |
| `new NodejsFunction(...)` ×4 | `AWS::Lambda::Function`, `AWS::IAM::Role`, `AWS::IAM::Policy`, `AWS::Logs::LogGroup`. The function's `Code` points at an asset in the bootstrap bucket. |
| `new apigwv2.HttpApi(...)` + route | `AWS::ApiGatewayV2::Api`, `::Stage`, `::Route`, `::Integration`, `AWS::Lambda::Permission` |
| `new sqs.Queue(...)` ×2 | `AWS::SQS::Queue` ×2, `AWS::SQS::QueuePolicy` (the `enforceSSL` deny statement) |
| `caseWorker.addEventSource(...)` | `AWS::Lambda::EventSourceMapping` |
| `new s3.Bucket(...)` ×2 | `AWS::S3::Bucket`, `AWS::S3::BucketPolicy`, and for `autoDeleteObjects` a `Custom::S3AutoDeleteObjects` backed by a helper Lambda CDK adds |
| `new cloudwatch.Alarm(...)` ×3 | `AWS::CloudWatch::Alarm` |
| `new CfnOutput(...)` | `Outputs:` section |
| `Tags.of(this).add(...)` | A `Tags:` list on every taggable resource |

## The same table, three ways

**CDK (this repo):**

```ts
const idempotency = new dynamodb.Table(this, "Idempotency", {
  partitionKey: { name: "idempotencyKey", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "expiresAt",
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
idempotency.grantReadWriteData(decide);
```

**CloudFormation (what synth produces, trimmed):**

```yaml
Resources:
  IdempotencyTable:
    Type: AWS::DynamoDB::Table
    Properties:
      KeySchema:
        - AttributeName: idempotencyKey
          KeyType: HASH
      AttributeDefinitions:
        - AttributeName: idempotencyKey
          AttributeType: S
      BillingMode: PAY_PER_REQUEST
      TimeToLiveSpecification:
        AttributeName: expiresAt
        Enabled: true
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
    UpdateReplacePolicy: Delete
    DeletionPolicy: Delete

  DecideFnServiceRoleDefaultPolicy:
    Type: AWS::IAM::Policy
    Properties:
      PolicyDocument:
        Statement:
          - Effect: Allow
            Action:
              - dynamodb:BatchGetItem
              - dynamodb:GetItem
              - dynamodb:Query
              - dynamodb:Scan
              - dynamodb:BatchWriteItem
              - dynamodb:PutItem
              - dynamodb:UpdateItem
              - dynamodb:DeleteItem
              - dynamodb:DescribeTable
            Resource:
              - !GetAtt IdempotencyTable.Arn
              - !Ref AWS::NoValue   # no index on this table
      Roles:
        - !Ref DecideFnServiceRole
```

Notice what `grantReadWriteData` did: the exact action list and the exact ARN. Hand-written CloudFormation tends to drift toward `dynamodb:*` on `*` because the precise version is tedious. That's the single strongest argument for CDK in a least-privilege conversation.

**Terraform (for comparison, since that's your background):**

```hcl
resource "aws_dynamodb_table" "idempotency" {
  name         = "meridian-idempotency"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "idempotencyKey"
  attribute { name = "idempotencyKey"; type = "S" }
  ttl { attribute_name = "expiresAt"; enabled = true }
  point_in_time_recovery { enabled = true }
}
```

Terraform keeps its own state file (you secure it: S3 plus locking) and shows a `plan`. CloudFormation keeps state in the service and shows a change set. CDK adds a real programming language and unit tests on top of CloudFormation. All three can satisfy a regulated shop; what reviewers actually care about is a reviewable diff, policy gates, and an auditable deploy identity.

## Things a CloudFormation team will ask about

- **Change sets.** `cdk deploy` creates and executes one. In CI you can split that: create the change set, post it for review, execute on approval. CloudFormation Git sync can comment the proposed changes on a PR directly.
- **Drift.** CloudFormation drift detection compares the deployed resources to the template. Schedule it (an AWS Config rule exists for this) and alarm on drift; a resource edited in the console is a control failure in a regulated firm, not just a nuisance.
- **Stack policies.** JSON that forbids updates to specific resources, like a production table, even from a valid template. CDK doesn't manage these; add them with the CLI or through a pipeline step.
- **StackSets.** Deploy one template across many accounts and regions. CDK's equivalent is CDK Pipelines with waves per account.
- **Importing existing resources.** CloudFormation can import resources created by hand; the IaC generator can scan an account and write the template and even a CDK app for it.
- **Nested stacks vs. constructs.** CloudFormation reuses templates through nested stacks; CDK reuses code through constructs and only nests stacks when it has to.
- **Custom resources.** CDK uses them for things CloudFormation can't do natively (emptying a bucket on delete, for instance). A CloudFormation team should know those helper Lambdas exist, because they show up in the template and in security scans.
