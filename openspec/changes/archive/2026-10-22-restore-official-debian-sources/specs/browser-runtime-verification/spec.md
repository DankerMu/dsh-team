## REMOVED Requirements

### Requirement: Verification image mirror selection preserves Debian trust and acceptance

**Reason**: The user explicitly replaced the forced third-party mirror policy with inherited official repositories. Rewrite-layout validation no longer applies because no source writer remains.

**Migration**: Use the official-source requirement below; remove the auxiliary context and helper atomically. Retain all existing trust, runtime and full-discovery acceptance requirements.

## ADDED Requirements

### Requirement: Verification image official sources preserve Debian trust and acceptance

The verification browser image SHALL retain its pinned base's original official Debian bookworm, bookworm-updates and security sources rather than forcibly selecting a third-party mirror. Construction MUST preserve Debian archive signature and validity checks, the shipped keyring, suites, components, package list, pinned base-image digest and existing600-second provisioning deadline. It MUST NOT inject runtime proxy configuration. The separately approved user-image build policy MUST use the same official-source policy without a shared source-rewrite mechanism. Failed repository authentication or inability to complete dependency installation MUST fail rather than weakening trust, silently falling back or reporting successful acceptance.

#### Scenario: Ordinary verification dependencies use official repositories

- **WHEN** the delivered verification image builds from its pinned base
- **THEN** ordinary sources, the official security source and trust configuration remain intact without an auxiliary source-rewrite context, and the existing full Docker command must complete provisioning within its unchanged deadline before consumer acceptance

#### Scenario: Official dependency acquisition fails

- **WHEN** official repository acquisition or authentication prevents dependency installation from completing
- **THEN** the build fails without disabling authentication, selecting a different mirror, changing the base digest, increasing the deadline or reporting successful acceptance
