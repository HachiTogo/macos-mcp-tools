import { z } from "zod"

// The structuredContent each mail read tool declares, error results included: the SDK validates
// both. Objects are loose, so a field present only sometimes, or added later, never fails a call
// that worked. Nested items detail only what agents pass back, such as an email's handle.

const handle = z.looseObject({ account_id: z.string(), mailbox_url: z.string(), mail_id: z.string() })

export const emailListOutput = z.looseObject({
  source: z.string(),
  query: z.looseObject({ limit: z.number(), offset: z.number(), timeZone: z.string() }),
  messages: z.array(z.looseObject({ id: z.string(), subject: z.string(), handle })),
})

export const mailAccountsOutput = z.looseObject({
  source: z.string(),
  configPath: z.string(),
  accounts: z.array(
    z.looseObject({
      accountId: z.string(),
      provider: z.string(),
      mailboxes: z.array(z.looseObject({ name: z.string(), mailboxUrl: z.string() })),
    }),
  ),
})

export const emailBodyOutput = z.looseObject({ handle, found: z.boolean(), body: z.string(), truncated: z.boolean() })

export const emailLinksOutput = z.looseObject({
  handle,
  found: z.boolean(),
  links: z.array(z.looseObject({ url: z.string(), text: z.string() })),
  count: z.number(),
  truncated: z.boolean(),
})

export const emailAttachmentsOutput = z.looseObject({
  handle,
  found: z.boolean(),
  attachments: z.array(z.looseObject({ name: z.string() })),
})

export const emailAttachmentOutput = z.looseObject({
  handle,
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  content: z.string(),
  format: z.enum(["text", "base64"]),
})
