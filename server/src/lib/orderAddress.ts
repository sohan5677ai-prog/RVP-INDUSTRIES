import { prisma } from './prisma.js';

export interface BuyerAddressInfo {
  id?: string | null;
  label?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  destination?: string | null;
  phone?: string | null;
  phone2?: string | null;
  locationLink?: string | null;
  isDefault?: boolean;
}

export interface OrderAddressResolution {
  selectedAddress: BuyerAddressInfo | null;
  effectivePhone: string | null;
  effectivePhone2: string | null;
  effectiveLocationLink: string | null;
  effectiveAddress: string | null;
  effectiveCity: string | null;
  effectiveState: string | null;
  effectivePincode: string | null;
  effectiveGstin: string | null;
  effectiveDestination: string | null;
  allBuyerPhones: string[];
}

/**
 * Resolve the party address record for a SaleOrder.
 * Matches by buyerAddressId first; if missing/broken, falls back to matching by
 * stored address text/label, then default address.
 */
export async function resolveOrderBuyerAddress(order: {
  buyerId?: string;
  buyerAddressId?: string | null;
  buyerAddress?: string | null;
  buyerCity?: string | null;
  buyer?: {
    id: string;
    name?: string;
    phone?: string | null;
    phone2?: string | null;
    locationLink?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    pincode?: string | null;
    gstin?: string | null;
    destination?: string | null;
    addresses?: BuyerAddressInfo[];
  } | null;
}): Promise<BuyerAddressInfo | null> {
  const buyerId = order.buyer?.id || order.buyerId;

  if (order.buyerAddressId) {
    const direct = await prisma.partyAddress.findUnique({ where: { id: order.buyerAddressId } });
    if (direct) return direct;
  }

  if (!buyerId) return null;

  const addrs: BuyerAddressInfo[] =
    order.buyer?.addresses && order.buyer.addresses.length > 0
      ? order.buyer.addresses
      : await prisma.partyAddress.findMany({ where: { partyId: buyerId }, orderBy: { createdAt: 'asc' } });

  if (addrs.length === 0) return null;

  // 1. Try matching by exact address or label if order has buyerAddress recorded
  if (order.buyerAddress) {
    const cleanOrderAddr = order.buyerAddress.trim().toLowerCase();
    const matched = addrs.find((a) => {
      const aAddr = a.address?.trim().toLowerCase();
      const aLabel = a.label?.trim().toLowerCase();
      if (aAddr && aAddr === cleanOrderAddr) return true;
      if (aLabel && (aLabel === cleanOrderAddr || cleanOrderAddr.includes(aLabel))) return true;
      return false;
    });
    if (matched) return matched;
  }

  // 2. Try matching by city if buyerCity recorded
  if (order.buyerCity) {
    const cleanCity = order.buyerCity.trim().toLowerCase();
    const cityMatches = addrs.filter((a) => a.city?.trim().toLowerCase() === cleanCity);
    if (cityMatches.length === 1) return cityMatches[0];
  }

  // 3. Fallback to default address or first address
  return addrs.find((a) => a.isDefault) || addrs[0] || null;
}

/**
 * Compute the effective address, phone, location link, and destination for a SaleOrder.
 * Priority: Specific branch address details > order snapshot details > buyer master details.
 */
export async function resolveOrderEffectiveDetails(order: {
  buyerId?: string;
  buyerAddressId?: string | null;
  buyerAddress?: string | null;
  buyerCity?: string | null;
  buyerState?: string | null;
  buyerPincode?: string | null;
  buyerGstin?: string | null;
  buyerPhone?: string | null;
  buyerPhone2?: string | null;
  buyerLocationLink?: string | null;
  destination?: string | null;
  buyer?: {
    id: string;
    name?: string;
    phone?: string | null;
    phone2?: string | null;
    locationLink?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    pincode?: string | null;
    gstin?: string | null;
    destination?: string | null;
    addresses?: BuyerAddressInfo[];
  } | null;
}): Promise<OrderAddressResolution> {
  const selectedAddress = await resolveOrderBuyerAddress(order);

  const effectivePhone =
    selectedAddress?.phone || order.buyerPhone || order.buyer?.phone || null;
  const effectivePhone2 =
    selectedAddress?.phone2 || order.buyerPhone2 || order.buyer?.phone2 || null;
  const effectiveLocationLink =
    selectedAddress?.locationLink || order.buyerLocationLink || order.buyer?.locationLink || null;
  const effectiveAddress =
    order.buyerAddress || selectedAddress?.address || order.buyer?.address || null;
  const effectiveCity =
    order.buyerCity || selectedAddress?.city || order.buyer?.city || null;
  const effectiveState =
    order.buyerState || selectedAddress?.state || order.buyer?.state || null;
  const effectivePincode =
    order.buyerPincode || selectedAddress?.pincode || order.buyer?.pincode || null;
  const effectiveGstin =
    order.buyerGstin || selectedAddress?.gstin || order.buyer?.gstin || null;
  const effectiveDestination =
    order.destination || selectedAddress?.destination || order.buyer?.destination || null;

  // Phone 1 only: Invoices, E-Way Bills & statements go to Phone 1. Phone 2 is reserved as the point of contact for drivers.
  const allBuyerPhones = Array.from(
    new Set(
      [
        selectedAddress?.phone,
        order.buyerPhone,
        order.buyer?.phone,
      ]
        .filter(Boolean)
        .map((p) => p!.trim())
    )
  );

  return {
    selectedAddress,
    effectivePhone,
    effectivePhone2,
    effectiveLocationLink,
    effectiveAddress,
    effectiveCity,
    effectiveState,
    effectivePincode,
    effectiveGstin,
    effectiveDestination,
    allBuyerPhones,
  };
}
