import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { WeighbridgeTicket } from '@/lib/types';

type WeighbridgeMatchParams = {
  date?: string;
  partyName?: string | null;
  vehicleNumber?: string | null;
};

/**
 * Finds the Kata ticket belonging to one business movement. The server performs
 * the canonical lorry/party matching so Stock In, Purchase and Dispatch all use
 * exactly the same rule.
 */
export function useWeighbridgeMatch({ date, partyName, vehicleNumber }: WeighbridgeMatchParams) {
  const cleanVehicle = vehicleNumber?.trim() ?? '';
  const cleanParty = partyName?.trim() ?? '';

  return useQuery<WeighbridgeTicket | null>({
    queryKey: ['weighbridge-ticket-match', date, cleanParty, cleanVehicle],
    queryFn: () => api<WeighbridgeTicket | null>(
      `/weighbridge/tickets/match?date=${encodeURIComponent(date!)}`
      + `&partyName=${encodeURIComponent(cleanParty)}`
      + `&vehicleNumber=${encodeURIComponent(cleanVehicle)}`,
    ),
    enabled: Boolean(date && cleanParty && cleanVehicle.length >= 4),
    staleTime: 15_000,
    retry: false,
  });
}
