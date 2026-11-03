/** A small normalization seed supplements open discovery; it is not a brand allowlist. */
export interface BrandAlias {
  brand: string;
  aliases: readonly string[];
  domains: readonly string[];
}
export const BRAND_ALIASES: readonly BrandAlias[] = Object.freeze([
  {
    brand: 'HubSpot',
    aliases: ['HubSpot CRM', 'HubSpot'],
    domains: ['hubspot.com'],
  },
  { brand: 'Pipedrive', aliases: ['Pipedrive'], domains: ['pipedrive.com'] },
  { brand: 'Attio', aliases: ['Attio'], domains: ['attio.com'] },
  { brand: 'Close', aliases: ['Close'], domains: ['close.com'] },
  {
    brand: 'Salesforce Starter Suite',
    aliases: ['Salesforce Starter Suite'],
    domains: ['salesforce.com'],
  },
  { brand: 'Salesforce', aliases: ['Salesforce'], domains: ['salesforce.com'] },
]);
