# Hex TTT Deploy Runbook

This runbook covers the custom-domain deploy flow for `he-xo.com` and what to check when the domain is broken.

## Standard Deploy (Hardened)

Run from repo root:

```bash
npm run infra:deploy
```

This calls the hardened infra deploy wrapper which:

- resolves `CertificateArn` from `HexTttCertificateStack` automatically
- deploys `HexTttStack` with `domainName`, `hostedZoneDomain`, `includeWww`, and `certificateArn` contexts

Optional overrides:

```bash
DOMAIN_NAME=he-xo.com HOSTED_ZONE_DOMAIN=he-xo.com INCLUDE_WWW=true CERTIFICATE_ARN=<arn> npm run infra:deploy
```

## If he-xo.com Is Broken

### 1. Check CloudFront alias + cert

```bash
aws cloudfront get-distribution --id E3AKOL8T3GIS57 \
  --query "Distribution.DistributionConfig.{Aliases:Aliases.Items,CertArn:ViewerCertificate.ACMCertificateArn,CertSource:ViewerCertificate.CertificateSource}" \
  --output json
```

Expected:

- aliases include `he-xo.com` and `www.he-xo.com`
- cert source is `acm`
- cert ARN is present

### 2. Check Route53 records

```bash
aws route53 list-resource-record-sets --hosted-zone-id Z0258682MF4417ZN1M2R \
  --query "ResourceRecordSets[?Name=='he-xo.com.' || Name=='www.he-xo.com.'].[Name,Type,AliasTarget.DNSName]" \
  --output table
```

Expected:

- `A` + `AAAA` for both apex and `www`
- aliases target `do1htg5shwgo7.cloudfront.net.`

### 3. If either check fails, redeploy hardened flow

```bash
npm run infra:deploy
```

### 4. Verify stack outputs

```bash
aws cloudformation describe-stacks --stack-name HexTttStack --query "Stacks[0].Outputs" --output table
```

Expected output key:

- `CustomDomainUrl = https://he-xo.com`

## Certificate Maintenance

If `HexTttCertificateStack` does not exist or cert is invalid, create/refresh it:

```bash
npm --prefix infra run deploy:cert
```

Then run:

```bash
npm run infra:deploy
```

