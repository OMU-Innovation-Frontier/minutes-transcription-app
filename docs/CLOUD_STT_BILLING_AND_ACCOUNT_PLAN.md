# Cloud STT Billing and Account Plan

## Status

- Status: **Under evaluation**
- Confirmed: 2026-07-19
- No cloud account, payment method, API key, paid service, or free quota was created or enabled during this research.
- Contracting party, service owner, billing owner, budget approver, data protection reviewer, and incident contact are all **undecided**.

Do not begin paid use until those roles and the written approval gates below are complete. Do not use a developer's personal card, personal PayPal account, or personal bank account for project usage.

## How API billing works

Creating an API key normally does not itself create a usage charge. A charge is generated when the credential invokes a billable model or related cloud resource. The invoice belongs to the cloud billing account/project/subscription that owns the credential, not to the GitHub organization and not to the browser user.

A “budget” often means an alert, not a hard stop. Provider-side free-tier enforcement, a quota-only mode, disabled billing, and application-side audio caps are different controls and should be layered. Billing dashboards may update after usage, so an application must never treat a dashboard alert as a real-time circuit breaker.

## Proposed ownership model

| Item | Required decision | Current state |
|---|---|---|
| Contracting party | University, research team legal entity, or other approved institution | Undecided |
| Cloud organization/account owner | Institution-controlled cloud organization separate from GitHub organization | Undecided |
| Billing owner | Person/team authorized to view invoices and payment profiles | Undecided |
| Budget approver | Person authorized to approve a paid pilot and maximum amount | Undecided |
| Technical service owner | Maintains keys, quotas, provider and incident response | Undecided |
| Data protection reviewer | Reviews DPA, region, subprocessors, retention and participant consent | Undecided |
| Incident contact | Revokes credentials and stops external STT | Undecided |
| Cost center/project code | Institution-approved billing classification | Undecided |

Acceptable account patterns to consider are a university/research-team account, a cloud organization account distinct from GitHub, an account administered by an accountable project lead, or a free-quota-only validation account under institutional control. A personal account is not the default merely because it is quicker to create.

## Provider billing comparison

| Provider | Account charged | Payment registration | Free allowance | End-of-free behavior | Budget/hard stop | Usage and invoice view |
|---|---|---|---|---|---|---|
| Alibaba Cloud Model Studio | Alibaba Cloud international billing account that owns the workspace/API key; individual and enterprise profiles exist, and enterprise multi-account settlement is possible | Free quota can stop for an incomplete profile; PAYG requires a completed account/profile and supported payment method such as verified card/PayPal; enterprise credit-control may use bank transfer | Qwen and Fun realtime each list 36,000 seconds, valid 90 days after activation | Completed profile moves automatically to PAYG unless Free Quota Only is enabled; incomplete profile stops with `AllocationQuota.FreeTierOnly` | **Free Quota Only** is the strongest documented guard. Budgets/monitoring should still be configured | Expenses & Costs, Cost Overview/Analysis, Model Studio usage statistics, free-quota details and bills |
| OpenAI API | OpenAI organization/project that owns the API key | Individual/team API accounts commonly purchase prepaid credit with card or use automatic billing; enterprise terms may invoice | No generally guaranteed recurring API free quota | Prepaid requests eventually reject after balance is consumed, but delayed cutoff can create a negative balance; auto-recharge may add funds if enabled | Project monthly budgets are soft alerts and do not stop requests. Disable auto-recharge and add app caps | Organization/project Usage Dashboard and billing pages |
| Google Cloud STT | Cloud Billing account linked to the Google Cloud project | New-customer trial requires a payment method for identity verification; trial does not charge unless manually upgraded | New customers: USD 300 for 90 days, across eligible Google Cloud services; no recurring V2 STT free minutes documented | Without manual upgrade the trial stops and resources close after credit/expiry; after upgrade, PAYG continues | Trial spending limit is effective; paid budgets are alerts, not caps. Programmatic billing disable is delayed/destructive and not an exact STT cap | Cloud Billing reports, Cost table, budgets, project usage/quotas |
| Azure AI Speech | Azure subscription and billing account that owns the Speech resource | Azure signup/payment verification depends on offer; paid subscription uses its configured payment method or enterprise agreement | Speech F0: 5 realtime audio hours/month | F0 quota rejects until reset; switching resource/tier to paid is explicit | Free-account spending limit applies only to eligible free account. PAYG has no spending limit; budgets alert only | Azure Cost Management, subscription/resource metrics and invoices |
| Amazon Transcribe | AWS payer account; AWS Organizations can consolidate member-account charges | AWS account registration normally requires a valid payment method; enterprise invoicing depends on agreement | 60 minutes/month for 12 months from first transcription request | Transcribe automatically charges PAYG beyond the free allowance | No service-specific Free Quota Only. AWS Budgets data updates at least daily; actions/alerts cannot be treated as an exact cap | Billing and Cost Management, Cost Explorer, AWS Budgets, CloudWatch/service metrics |

## Alibaba Cloud controls required for a free-quota prototype

1. Create no account until the contracting party and administrator are approved.
2. Use the international service and a Singapore workspace. Do not mix mainland-China endpoints, model pages, quotas, or billing terms.
3. Before issuing an API key, enable **Free Quota Only** and capture non-secret evidence that it is enabled.
4. Verify the exact model's remaining quota and its 90-day expiration in Model Studio.
5. Give the application identity only the minimum workspace permission. Never place the key in a `VITE_` variable, browser response, health endpoint, transcript record, test fixture, or GitHub Actions file.
6. Set model-usage alerts in Model Studio/Expenses & Costs, while recognizing that reporting can lag.
7. Add independent application limits: per-session seconds, daily seconds, monthly seconds, concurrent sessions and no automatic replay after uncertain failures.
8. On quota exhaustion, treat HTTP 403 `AllocationQuota.FreeTierOnly` as a safe terminal condition. Do not silently disable the guard or fall back to PAYG.
9. Do not complete a PAYG profile or add payment simply to bypass a quota error without written approval.

The official free-quota page states that Free Quota Only is disabled by default. A profile-completed user can therefore transition automatically to PAYG when free quota ends. That default is unacceptable for this project.

## Payment timing and account implications

### Alibaba Cloud

- A default billing account is associated with the account. Individual and enterprise profiles have different governance options.
- Supported international payment paths include verified card and PayPal; credit-control enterprise arrangements can support bank transfer. Card verification may create a small temporary authorization.
- PAYG is tracked as usage and settled through the billing account. The international payment documentation describes automatic collection thresholds and settlement timing.
- API-key creation is not the billable event; model inference is. Enabling Model Studio itself is documented as free, but other cloud resources can still incur charges.
- The approved pilot should remain Free Quota Only, so no project member needs to register a personal payment method.

### OpenAI

- Prepaid billing purchases credit in advance; purchased credits expire after one year and are non-refundable.
- Auto-recharge may be offered and should remain off for a capped test. The project budget field is not a hard cap.
- Enterprise invoicing is an institutional alternative, but it requires an approved contract owner.

### Google Cloud

- The new-customer trial asks for a payment method to verify identity. It does not automatically convert to paid; an authorized user must upgrade.
- After an upgrade, remaining trial credit can be consumed and subsequent usage is billed. Paid budgets only notify.
- Because the trial is account-wide rather than STT-specific, another workload can consume the same credit.

### Azure

- F0 is a service tier/quota, not a cash credit. A paid Speech tier or paid subscription change must be separately approved.
- Azure free-account spending limits can stop eligible resources after credit, but ordinary PAYG subscriptions have no spending limit.
- Azure budget alerts are monitoring, not enforcement.

### AWS

- The Transcribe free tier automatically rolls into the regional PAYG rate after the allowance. There is no documented Transcribe-only hard stop.
- AWS Budgets and anomaly detection are delayed. Budget actions can help with IAM/service control but are not guaranteed to stop a stream at the threshold.
- Use an organization-controlled member account and a payer account; do not rely on a personal root account/card.

## Required layered limits

Even for free quota:

- Provider guard: Free Quota Only or a genuinely non-upgrading free tier where available.
- Credential guard: server-only secret, narrow IAM/workspace scope, rotation and immediate revocation procedure.
- Application guard: maximum 10 minutes per first session, 30 minutes/day during engineering, and a separately approved monthly cap. Exact production values remain undecided.
- Concurrency guard: one test session initially.
- Retry guard: no automatic resend after audio may have reached the provider; bounded connection retries before any audio only.
- Logging guard: usage seconds, model, session identifier, status and safe error code only; no audio or full transcript in normal logs.
- Monitoring guard: provider quota/usage view plus local accumulated audio seconds.
- Human guard: the pilot operator checks remaining free quota before and after every run.

## Paid-use approval checklist

All boxes must be approved before any paid API call:

- [ ] Contracting party and account owner are named.
- [ ] Billing owner and budget approver are named.
- [ ] Data protection reviewer approves region, DPA, subprocessors, retention and deletion.
- [ ] Meeting-participant consent UI/text is approved.
- [ ] Provider/model/region and exact current rate are recorded.
- [ ] A written monthly currency limit and project duration are approved.
- [ ] Payment method is institutional, not personal.
- [ ] Free Quota Only behavior has been tested without audio containing personal information.
- [ ] Server-side session/day/month caps and credential revocation have automated tests.
- [ ] Usage dashboard and alert recipients are configured.
- [ ] An incident and accidental-charge response procedure is documented.
- [ ] The synthetic benchmark demonstrates acceptable accuracy, latency and ordering.

Until every required owner and approval is resolved, the policy is: **do not activate paid cloud STT**.

## Official references

Checked 2026-07-19:

- Alibaba Cloud, [Free quota for new users](https://www.alibabacloud.com/help/en/model-studio/new-free-quota), updated 2026-06-23, international/Singapore.
- Alibaba Cloud, [Model inference pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing), updated 2026-07-15.
- Alibaba Cloud, [Model usage statistics](https://www.alibabacloud.com/help/en/model-studio/model-usage-statistics), updated 2026-06-11.
- Alibaba Cloud, [Billing and Costs product introduction](https://www.alibabacloud.com/help/en/user-center/product-overview/billings-and-costs-product-introduction/), updated 2026-06-21.
- Alibaba Cloud, [Fund account overview](https://www.alibabacloud.com/help/en/user-center/fund-account-overview), updated 2026-07-02.
- Alibaba Cloud, [Payment management](https://www.alibabacloud.com/help/en/user-center/instruction-of-payment-management/), updated 2026-07-01.
- OpenAI, [Prepaid billing](https://help.openai.com/en/articles/8264644-what-is-prepaid-billing), official Help Center; stable page date not shown.
- OpenAI, [Managing projects](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform), official Help Center; stable page date not shown.
- Google Cloud, [Free cloud features and trial](https://docs.cloud.google.com/free/docs/free-cloud-features), official documentation; stable page date not shown.
- Google Cloud, [Cloud Billing budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets), official documentation; stable page date not shown.
- Microsoft, [Azure spending limit](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit), official Learn documentation; stable page date not shown.
- AWS, [Amazon Transcribe pricing](https://aws.amazon.com/transcribe/pricing/), official pricing; stable page date not shown.
- AWS, [AWS Budgets best practices](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html), official documentation; stable page date not shown.
