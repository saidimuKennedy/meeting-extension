export const templates = [
  {
    id: 'standard',
    name: 'Standard meeting',
    system: 'You are an executive assistant. Produce concise, faithful meeting notes in Markdown. Never invent facts. If something is unclear, omit it.',
    user: (t) => [
      'Summarize this meeting transcript using exactly this structure:',
      '',
      '# Summary',
      '(2-3 sentences)',
      '',
      '# Key Decisions',
      '- ...',
      '',
      '# Action Items',
      '- [ ] Owner — task',
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
    system: 'You are a team lead summarizing a standup. Be terse and factual.',
    user: (t) => [
      'From this standup transcript, produce:',
      '',
      '# Done',
      '# Doing',
      '# Blockers',
      '# Action Items',
      '- [ ] Owner — task',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  }
];
