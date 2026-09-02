# bpsyc-rems-deployment

A **thin** REMS deployment for BPSYC (Biological Psychiatry Data Commons). This
repo holds configuration only; all the CDK logic lives in the shared engine
[`rems-aws-cdk-core`](https://github.com/AustralianBioCommons/rems-aws-cdk-core),
pinned in `package.json`.

```
bpsyc-rems-deployment/
├─ bin/app.ts            # ~5 lines: load config/<env>.json -> createRemsApp()
├─ config/
│   ├─ dev.json          # committed, NON-SENSITIVE config per environment
│   ├─ staging.json
│   └─ prod.json
├─ .github/workflows/    # OIDC deploy; reads the JSON, needs no GitHub Secrets
├─ cdk.json              # feature-flag context (copied from the engine)
├─ cdk.context.json      # EMPTY — never inherit another account's lookups
└─ package.json          # pins rems-aws-cdk-core#<tag>
```

## Config is committed JSON — and that's deliberate

`config/<env>.json` holds only **non-sensitive** values: account IDs, DNS names,
sizing, and **ARNs**. ARNs (the ACM cert, the deploy role, the three
`*SecretArn` fields) are *references*, not secret material — the actual secrets
live in Secrets Manager and IAM controls who can read them. Knowing an ARN
grants nothing. So this config lives in git in the clear; there are no GitHub
Secrets to manage.

**Never** put secret *values* in these files — only the `*SecretArn` pointers.

## How isolation & auth work

Each project deploys into **its own AWS account**, so identical stack/resource
names never collide — the account boundary is the isolation. The pipeline's only
privilege is assuming this project's `deployRoleArn` via GitHub OIDC; that role's
**trust policy** (scoped to this repo + environment) is the security boundary,
not secrecy of any string in this repo.

## Create a new project from this template

1. Clone/rename this repo (`<project>-rems-deployment`).
2. Edit `config/*.json`: replace the `REPLACE_*` placeholders (account IDs, cert
   ARN, secret ARNs, host names) with this project's real, non-sensitive values.
3. Create the OIDC deploy role in each target account, trust-scoped to this repo.
4. Point `rems-aws-cdk-core` in `package.json` at the engine version to pin.
5. Push to `develop` (-> dev) or `main` (-> staging -> prod).

## DNS record

By default CDK creates the ALB alias record for `hostName` in the zone named by
`hostZone` (a name-based Route 53 lookup). Two escape hatches:

- **Manage DNS manually.** Set `"manageDnsRecord": false` in the env config —
  CDK then skips the lookup and the record entirely. Point your own record at
  the `LoadBalancerDnsName` stack output. Use this for centralised/cross-account
  DNS, or when the zone lives in another account.
- **Skip the lookup.** Keep `manageDnsRecord: true` and set `"hostedZoneId":
  "<Z...>"`; CDK uses that id directly (deterministic, no synth-time lookup or
  credentials) instead of searching by name.

## Upgrading the engine

Bump the `rems-aws-cdk-core` tag in `package.json`, run `npx cdk diff` against
this project's account, review, merge. The pin is per-repo, so an engine change
for another project never reaches this one until you bump it here.

## Safety

`npx cdk diff` runs before every deploy. Nothing in this repo can touch another
project's stacks — different account, different deploy role.
