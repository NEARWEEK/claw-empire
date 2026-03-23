import React from 'react';
import { Composition } from 'remotion';
import { WeeklyReport } from './WeeklyReport';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="WeeklyReport"
        component={WeeklyReport}
        durationInFrames={30 * 30}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          clientName: 'Palmes',
          weekNumber: 13,
          date: '2026-03-23',
          metrics: { tasksCompleted: 12, hoursSaved: 34, automationsRunning: 3 },
          highlights: [
            'Launched product description engine for 200 SKUs',
            'Integrated Shopify order notifications with Slack',
            'Created automated social media calendar',
          ],
          nextSteps: [
            'Deploy customer service chatbot',
            'Connect inventory alerts to Teams',
            'Build seasonal campaign templates',
          ],
        }}
      />
    </>
  );
};
