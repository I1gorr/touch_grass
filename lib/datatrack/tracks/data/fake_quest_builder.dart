import '../../interfaces/quest_builder.dart';
import '../../interfaces/types.dart';

/// Hardcoded stops so Persons 1, 2 and 4 can build against QuestBuilder now.
class FakeQuestBuilder implements QuestBuilder {
  const FakeQuestBuilder();

  @override
  Future<List<Stop>> build(Location location) async => const [
        Stop(
          id: 'fake-1',
          osmId: 'node/1',
          name: 'Quiet Fountain',
          lat: 40.7810,
          lng: -73.9650,
          tagsJson: '{"amenity":"fountain"}',
          prompt: 'What sounds can you hear right now?',
        ),
        Stop(
          id: 'fake-2',
          osmId: 'node/2',
          name: 'Old Oak',
          lat: 40.7822,
          lng: -73.9638,
          tagsJson: '{"natural":"tree"}',
          prompt: 'What does this place remind you of?',
        ),
        Stop(
          id: 'fake-3',
          osmId: 'way/3',
          name: 'Lookout Rock',
          lat: 40.7835,
          lng: -73.9622,
          tagsJson: '{"tourism":"viewpoint"}',
          prompt: 'Describe the view in one sentence.',
        ),
      ];
}
