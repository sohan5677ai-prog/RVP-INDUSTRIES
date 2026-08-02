import type { SaleProduct } from './types';

/**
 * Goods description for a sale product, worded the way it is written on the
 * transporter's consignment note. Shared by the printed lorry receipt and the
 * lorry-receipt register on the Transport Report.
 */
export const PRODUCT_DESCRIPTION: Record<string, string> = {
  PAPPU: 'Tamarind Seed Pappu',
  HUSK: 'Tamarind Husk',
  WASTE: 'Tamarind Waste',
  TPS: 'Tamarind Seed Brokens',
  SHELL: 'Tamarind Shell',
  PRECLEANER_DUST: 'Pre Cleaner Dust',
  NALLA_POKKULU: 'Nalla Pokkulu',
  NALLA_CHINTAPANDU: 'Nalla Chintapandu',
};

export function productDescription(product?: SaleProduct | string | null): string {
  return PRODUCT_DESCRIPTION[product ?? 'PAPPU'] ?? 'Tamarind Seed Pappu';
}
