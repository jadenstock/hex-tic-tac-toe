#!/usr/bin/env bash
set -euo pipefail

# Hardened deploy flow for production custom domain wiring.
# Defaults target he-xo.com but can be overridden via environment variables.
DOMAIN_NAME="${DOMAIN_NAME:-he-xo.com}"
HOSTED_ZONE_DOMAIN="${HOSTED_ZONE_DOMAIN:-$DOMAIN_NAME}"
INCLUDE_WWW="${INCLUDE_WWW:-true}"
CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"

if [[ -z "$CERTIFICATE_ARN" ]]; then
  CERTIFICATE_ARN="$(aws cloudformation describe-stacks \
    --stack-name HexTttCertificateStack \
    --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]" \
    --output text 2>/dev/null || true)"
fi

if [[ -z "$CERTIFICATE_ARN" || "$CERTIFICATE_ARN" == "None" ]]; then
  echo "ERROR: Could not resolve CertificateArn."
  echo "Run certificate deployment first, then retry:"
  echo "  npm --prefix infra run deploy:cert"
  exit 1
fi

echo "Deploying HexTttStack with:"
echo "  domainName=$DOMAIN_NAME"
echo "  hostedZoneDomain=$HOSTED_ZONE_DOMAIN"
echo "  includeWww=$INCLUDE_WWW"
echo "  certificateArn=$CERTIFICATE_ARN"

npx cdk deploy --require-approval never HexTttStack \
  -c domainName="$DOMAIN_NAME" \
  -c hostedZoneDomain="$HOSTED_ZONE_DOMAIN" \
  -c includeWww="$INCLUDE_WWW" \
  -c certificateArn="$CERTIFICATE_ARN"

