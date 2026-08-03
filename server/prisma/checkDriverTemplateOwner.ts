import 'dotenv/config';

// One-off diagnostic for the DISPATCH_DRIVER "Template not found." failure.
// Calls Fast2SMS's WABA/template listing endpoint and checks whether the
// phone_number_id configured in FAST2SMS_PHONE_NUMBER_ID is actually the one
// that owns the approved "rvp_dispatch_driver" template - the Meta-format
// location-header send (sendLocationWhatsAppTemplate) will 404 with
// "Template not found." if it's pointed at the wrong number.
//
// Run from the Render shell, where FAST2SMS_API_KEY lives:
//   npx tsx prisma/checkDriverTemplateOwner.ts

const apiKey = process.env.FAST2SMS_API_KEY;
const configuredId = process.env.FAST2SMS_PHONE_NUMBER_ID;
const templateName = process.env.FAST2SMS_TMPL_NAME_DISPATCH_DRIVER?.trim() || 'rvp_dispatch_driver';

async function main() {
  if (!apiKey) {
    console.error('FAST2SMS_API_KEY is not set in this environment - run this from the Render shell.');
    process.exitCode = 1;
    return;
  }
  console.log(`Configured FAST2SMS_PHONE_NUMBER_ID: ${configuredId ?? '(not set)'}`);
  console.log(`Looking for template named: "${templateName}"\n`);

  const res = await fetch('https://www.fast2sms.com/dev/dlt_manager/whatsapp?type=template', {
    headers: { Authorization: apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, text.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const parsed = JSON.parse(text) as {
    success?: boolean;
    data?: Array<{
      phone_number_id: string;
      number: string;
      templates?: Array<{ template_name: string; status: string; language: string; message_id?: number }>;
    }>;
  };

  if (!parsed.data?.length) {
    console.log('No numbers/templates returned:', text.slice(0, 1000));
    return;
  }

  for (const entry of parsed.data) {
    const isConfigured = configuredId && entry.phone_number_id === configuredId;
    console.log(`Number ${entry.number}  (phone_number_id: ${entry.phone_number_id})${isConfigured ? '  <-- FAST2SMS_PHONE_NUMBER_ID' : ''}`);
    for (const t of entry.templates ?? []) {
      const hit = t.template_name === templateName ? '  <-- MATCH' : '';
      console.log(`    - ${t.template_name} | ${t.status} | lang=${t.language}${hit}`);
    }
  }

  const owner = parsed.data.find((e) => e.templates?.some((t) => t.template_name === templateName));
  console.log('\n--- Verdict ---');
  if (!owner) {
    console.log(`No number has a template named "${templateName}" at all - check the exact approved name.`);
  } else if (owner.phone_number_id === configuredId) {
    console.log(`OK: FAST2SMS_PHONE_NUMBER_ID (${configuredId}) already owns "${templateName}". The mismatch is elsewhere.`);
  } else {
    console.log(
      `MISMATCH: "${templateName}" is approved under phone_number_id ${owner.phone_number_id} (number ${owner.number}), ` +
        `but FAST2SMS_PHONE_NUMBER_ID is set to ${configuredId ?? '(not set)'}. ` +
        `Update the Render env var to ${owner.phone_number_id}.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
