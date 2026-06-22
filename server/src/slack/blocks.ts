import type { KnownBlock } from '@slack/types';

/** A labelled value rendered in a summary card. */
export interface Field {
  label: string;
  value: string;
}

export function headerBlock(text: string): KnownBlock {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

export function contextBlock(text: string): KnownBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/** A section whose fields render as a two-column "*label*\nvalue" grid. */
export function fieldsSection(fields: Field[]): KnownBlock {
  return {
    type: 'section',
    fields: fields.slice(0, 10).map((f) => ({
      type: 'mrkdwn',
      text: `*${f.label}*\n${f.value}`,
    })),
  };
}

/**
 * Approve / Edit / Cancel action row. Action ids are namespaced per flow
 * (e.g. "po:approve") so app.ts can route them. Edit is optional.
 */
export function approveEditCancel(flow: string, opts: { includeEdit?: boolean } = {}): KnownBlock {
  const elements: any[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Approve', emoji: true },
      style: 'primary',
      action_id: `${flow}:approve`,
    },
  ];
  if (opts.includeEdit) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Edit', emoji: true },
      action_id: `${flow}:edit`,
    });
  }
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Cancel', emoji: true },
    style: 'danger',
    action_id: `${flow}:cancel`,
  });
  return { type: 'actions', elements };
}

export interface SelectOption {
  text: string;
  value: string;
}

/** A static-select menu inside a section with an accessory. */
export function selectSection(
  actionId: string,
  label: string,
  placeholder: string,
  options: SelectOption[]
): KnownBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: label },
    accessory: {
      type: 'static_select',
      action_id: actionId,
      placeholder: { type: 'plain_text', text: placeholder, emoji: true },
      options: options.slice(0, 100).map((o) => ({
        text: { type: 'plain_text', text: o.text.slice(0, 75), emoji: true },
        value: o.value,
      })),
    },
  };
}
