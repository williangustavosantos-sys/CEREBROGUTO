import { createHash } from "node:crypto";

// Derivação canônica de um usuário legado (painel/V1/V2) para a identidade V3
// estável. É a ÚNICA fonte de verdade do mapeamento idempotente
// teamId -> tenantId e userId legado -> identity/user do Cérebro V3.
//
// O script de migração em massa (scripts/migrate-legacy-to-v3.ts) e o
// provisionamento ao vivo do painel (panel-provisioning.ts) DEVEM derivar os
// mesmos ids, senão o mesmo aluno ganharia duas identidades V3 distintas.
export function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

// Espelha exatamente o slug usado pela migração legada: o teamId bruto
// (trimado), com fallback "guto-core". Não slugifica — a consistência com o
// tenantId determinístico depende de manter a MESMA string de origem.
export function legacyTenantSlug(teamId: unknown): string {
  const trimmed = typeof teamId === "string" ? teamId.trim() : "";
  return trimmed || "guto-core";
}

export interface V3DerivedIdentity {
  tenantSlug: string;
  tenantId: string;
  identityId: string;
  userId: string;
  externalSubject: string;
}

export function deriveV3Identity(sourceUserId: string, teamId?: string | null): V3DerivedIdentity {
  const tenantSlug = legacyTenantSlug(teamId);
  const tenantId = deterministicUuid(`v3-tenant:${tenantSlug}`);
  const identityId = deterministicUuid(`v3-identity:${tenantSlug}:${sourceUserId}`);
  const userId = deterministicUuid(`v3-user:${tenantId}:${sourceUserId}`);
  return { tenantSlug, tenantId, identityId, userId, externalSubject: sourceUserId };
}
