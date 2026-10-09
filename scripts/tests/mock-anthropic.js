// Fake Anthropic API: records every request body, returns a canned tool call.
const http = require('http'); const fs = require('fs');
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    fs.appendFileSync('/tmp/ai-requests.log', b + '\n');
    const body = JSON.parse(b); const tool = body.tools[0].name;
    const input = tool === 'project_draft' ? {
      scope_exclusions: 'In scope:\n- Practice wall to 600 mm\n**Not included:**\n- Permanent walls',
      work_steps: [{ step: 'Set out', hazards: 'Trips', controls: 'Clear area' }, { step: 'Mix mortar', hazards: 'Cement burns', controls: 'Gloves, eye protection' }],
      ppe: '- Safety glasses\n- Gloves', induction_supervision: 'Direct supervision when cutting.',
      emergency_considerations: 'Eyewash: [confirm: location]', missing_information: ['Confirm first aid person'], assumptions: ['ASSUMPTION: bricks delivered on pallets'],
      cara_suggestions: 'Add brick saw to CARA PERAs.',
    } : { suggested_risk_level: 'High', risk_reason: 'x' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'mock', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4010, () => console.log('mock ai on 4010'));
