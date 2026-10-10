import { categoryOf, type Candidate } from '../routing/candidate';

const PROMPTS: Record<string, string> = {
  'tourism=artwork': 'What story do you think this artwork is telling?',
  'tourism=viewpoint': 'Describe the view in one sentence.',
  'amenity=fountain': 'What sounds can you hear right now?',
  'historic=*': 'Who might have stood here long ago?',
  'leisure=garden': 'What is the smallest living thing you can spot?',
  'leisure=park': 'What does this place remind you of?',
  'amenity=place_of_worship': 'What does the quiet here feel like?',
};

export const promptForCandidate = (c: Candidate): string => PROMPTS[categoryOf(c)] ?? 'What do you notice here?';
