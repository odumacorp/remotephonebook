import { z } from 'zod';

export const deviceSchema = z.object({
  deviceIdentifier: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Invalid device identifier'),
  platform: z.enum(['ios', 'android', 'web', 'other']),
  name: z.string().trim().max(80).optional(),
});

const identifier = z.string().trim().min(3).max(254);
const password = z.string().min(1).max(128);

export const registerSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required').max(120),
    email: z.string().trim().email('Enter a valid email address').max(254).optional().or(z.literal('').transform(() => undefined)),
    phone: z.string().trim().max(20).optional().or(z.literal('').transform(() => undefined)),
    password: z.string().max(128),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms and privacy policy' }) }),
    device: deviceSchema.optional(),
  })
  .refine((v) => v.email || v.phone, { message: 'Provide an email address or mobile number', path: ['email'] });

export const loginSchema = z.object({ identifier, password, device: deviceSchema.optional() });
export const verifySchema = z.object({ identifier, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'), device: deviceSchema.optional() });
export const resendSchema = z.object({ identifier });
export const recoverySchema = z.object({ identifier });
export const recoveryConfirmSchema = z.object({
  identifier,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  newPassword: z.string().max(128),
});

const numberSchema = z.object({
  number: z.string().max(40),
  label: z.string().max(40).nullish(),
  isPrimary: z.boolean().optional(),
});

export const contactInputSchema = z.object({
  displayName: z.string().max(200),
  numbers: z.array(numberSchema).max(20),
});

export const contactCreateSchema = contactInputSchema.extend({
  /** Marks fictional test contacts added from the app's demo screen. */
  isDemo: z.boolean().optional(),
});

export const contactPatchSchema = z.object({
  displayName: z.string().max(200).optional(),
  numbers: z.array(numberSchema).max(20).optional(),
  baseVersion: z.number().int().nonnegative().optional(),
});

export const syncSchema = z.object({
  upserts: z
    .array(contactInputSchema.extend({ sourceContactId: z.string().min(1).max(200), baseVersion: z.number().int().nonnegative().nullish() }))
    .default([]),
  deletes: z
    .array(z.union([z.string().min(1).max(200).transform((s) => ({ sourceContactId: s })), z.object({ sourceContactId: z.string().min(1).max(200), baseVersion: z.number().int().nonnegative().nullish() })]))
    .default([]),
  final: z.boolean().optional(),
  confirmMassDelete: z.boolean().optional(),
  stats: z.record(z.number()).optional(),
});

export const syncReportSchema = z.object({
  status: z.literal('error'),
  error: z.string().trim().min(1).max(300),
});

export const pageQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
