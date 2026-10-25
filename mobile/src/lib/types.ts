export interface ContactNumber {
  id: string;
  number: string;
  normalized: string;
  formatted: string;
  label: string | null;
  isPrimary: boolean;
}

export interface Contact {
  id: string;
  displayName: string;
  numbers: ContactNumber[];
  sourceContactId: string | null;
  fromThisDevice: boolean;
  isDemo: boolean;
  dedupeKey: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface User {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: 'pending_verification' | 'active' | 'suspended' | 'demo';
  ussdEnabled: boolean;
  ussdPinSet: boolean;
  deletionPolicy: 'mirror' | 'keep';
  contactsConsentAt: string | null;
  linkedPhones?: { id: string; phone: string; label: string | null; verifiedAt: string | null; ussdTrusted: boolean }[];
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ServerSyncStatus {
  totalContacts: number;
  lastSuccessfulSyncAt: string | null;
  status: 'never' | 'in_progress' | 'success' | 'error';
  lastError: string | null;
  devices: { deviceId: string; name: string | null; platform: string; lastSuccessfulSyncAt: string | null; status: string; lastError: string | null }[];
}

export interface Device {
  id: string;
  platform: string;
  name: string | null;
  lastSeenAt: string;
  createdAt: string;
  lastSyncAt: string | null;
  syncStatus: string | null;
  current: boolean;
}
