const NO_INVENT = 'Never invent facts, owners, decisions, due dates, or quotes. Only report owners and dates when the transcript states them explicitly. Distinguish confirmed decisions from proposals. Preserve risks, dependencies, disagreements, and open questions when present.';

export const noteFormats = [
  {
    id: 'general',
    name: 'General notes',
    system: `You are an expert meeting scribe. Produce clear, useful Markdown notes from the transcript. ${NO_INVENT}`,
    user: (t) => [
      'Write notes for this meeting. Choose whatever structure best fits the content (for example: Overview, Key Points, Decisions, Action Items, Open Questions). Keep it concise and factual.',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'standard',
    name: 'Standard meeting',
    system: `You are an executive assistant. Produce concise, faithful meeting notes in Markdown. ${NO_INVENT}`,
    user: (t) => [
      '# Summary',
      '(2-3 sentences)',
      '',
      '# Key Decisions',
      '- ...',
      '',
      '# Action Items',
      '- [ ] Owner — task (only when stated)',
      '',
      '# Discussion Highlights',
      '- ...',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'standup',
    name: 'Daily standup',
    system: `You summarize a standup. Be terse and factual. ${NO_INVENT}`,
    user: (t) => [
      '# Done',
      '# Doing',
      '# Blockers',
      '# Action Items',
      '- [ ] Owner — task (only when stated)',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'project_review',
    name: 'Project review',
    system: `You summarize a project review. Be structured and factual. ${NO_INVENT}`,
    user: (t) => [
      '# Status',
      '# Progress',
      '# Risks & Dependencies',
      '# Decisions',
      '# Action Items',
      '- [ ] Owner — task (only when stated)',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'interview',
    name: 'Interview',
    system: `You summarize an interview. Stay neutral and factual. ${NO_INVENT}`,
    user: (t) => [
      '# Candidate / Subject Overview',
      '# Strengths',
      '# Concerns',
      '# Notable Answers',
      '# Follow-ups',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'lecture',
    name: 'Lecture / training',
    system: `You summarize a lecture or training session for study. Be accurate and complete. ${NO_INVENT}`,
    user: (t) => [
      '# Overview',
      '# Key Concepts',
      '# Definitions',
      '# Examples',
      '# Questions to Review',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'action_items',
    name: 'Action items',
    system: `You extract action items and decisions. Be exhaustive but factual. ${NO_INVENT}`,
    user: (t) => [
      'List every action item and decision in the transcript.',
      '',
      '# Action Items',
      '- [ ] Owner — task (only when stated)',
      '',
      '# Decisions',
      '- ...',
      '',
      '# Open Questions',
      '- ...',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  }
];

export const templates = noteFormats;

export function getNoteFormat(id) {
  return noteFormats.find((format) => format.id === id) || noteFormats[0];
}

export function buildNoteMessages({ formatId, transcript, customInstructions = '' }) {
  const format = getNoteFormat(formatId);
  const system = customInstructions.trim()
    ? `${format.system}\n\nAdditional user instructions:\n${customInstructions.trim()}`
    : format.system;
  return [
    { role: 'system', content: system },
    { role: 'user', content: format.user(transcript) }
  ];
}

export function buildReductionMessages({ formatId, chunk, index, total, customInstructions = '' }) {
  const format = getNoteFormat(formatId);
  const system = `You extract faithful notes from ONE part of a longer meeting transcript. ${NO_INVENT} Do not write the final formatted notes; capture raw, accurate content that a later pass will merge.`;
  const extra = customInstructions.trim() ? `\nRespect these user instructions: ${customInstructions.trim()}` : '';
  const user = [
    `This is part ${index + 1} of ${total}. The final notes will use the "${format.name}" format.`,
    extra,
    'Capture: confirmed decisions, proposals, action items (owner/date only if stated), key facts, risks, dependencies, disagreements, and open questions.',
    '',
    'Transcript part:',
    '"""',
    chunk,
    '"""'
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}
