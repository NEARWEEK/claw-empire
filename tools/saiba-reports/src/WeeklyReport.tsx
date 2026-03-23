import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface ReportProps {
  clientName: string;
  weekNumber: number;
  date: string;
  metrics: {
    tasksCompleted: number;
    hoursSaved: number;
    automationsRunning: number;
  };
  highlights: string[];
  nextSteps: string[];
}

const BG = '#0f172a';
const ACCENT = '#10b981';
const WHITE = '#ffffff';
const MUTED = '#94a3b8';

const FadeIn: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 20 } });
  const y = interpolate(opacity, [0, 1], [30, 0]);
  return (
    <div style={{ opacity, transform: `translateY(${y}px)` }}>
      {children}
    </div>
  );
};

const Intro: React.FC<{ clientName: string; date: string; weekNumber: number }> = ({
  clientName,
  date,
  weekNumber,
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: BG,
      justifyContent: 'center',
      alignItems: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}
  >
    <FadeIn>
      <div style={{ fontSize: 28, color: ACCENT, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 20 }}>
        Saiba
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 64, color: WHITE, fontWeight: 700, marginBottom: 16 }}>
        Weekly Report
      </div>
    </FadeIn>
    <FadeIn delay={20}>
      <div style={{ fontSize: 32, color: MUTED }}>
        {clientName} — Week {weekNumber}
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{ fontSize: 20, color: MUTED, marginTop: 12 }}>{date}</div>
    </FadeIn>
  </AbsoluteFill>
);

const Summary: React.FC<{ metrics: ReportProps['metrics'] }> = ({ metrics }) => {
  const items = [
    { label: 'Tasks Completed', value: metrics.tasksCompleted, suffix: '' },
    { label: 'Hours Saved', value: metrics.hoursSaved, suffix: 'h' },
    { label: 'Automations Running', value: metrics.automationsRunning, suffix: '' },
  ];
  return (
    <AbsoluteFill
      style={{
        backgroundColor: BG,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <FadeIn>
        <div style={{ fontSize: 20, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 48 }}>
          This Week
        </div>
      </FadeIn>
      <div style={{ display: 'flex', gap: 80 }}>
        {items.map((item, i) => (
          <FadeIn key={item.label} delay={10 + i * 15}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 72, color: WHITE, fontWeight: 700 }}>
                {item.value}{item.suffix}
              </div>
              <div style={{ fontSize: 18, color: MUTED, marginTop: 8 }}>
                {item.label}
              </div>
            </div>
          </FadeIn>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Highlights: React.FC<{ highlights: string[] }> = ({ highlights }) => (
  <AbsoluteFill
    style={{
      backgroundColor: BG,
      justifyContent: 'center',
      padding: '0 120px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}
  >
    <FadeIn>
      <div style={{ fontSize: 20, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 48 }}>
        Highlights
      </div>
    </FadeIn>
    {highlights.map((h, i) => (
      <FadeIn key={i} delay={15 + i * 20}>
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 32 }}>
          <div style={{ fontSize: 24, color: ACCENT, marginRight: 20, fontWeight: 700, minWidth: 30 }}>
            {i + 1}.
          </div>
          <div style={{ fontSize: 28, color: WHITE, lineHeight: 1.4 }}>
            {h}
          </div>
        </div>
      </FadeIn>
    ))}
  </AbsoluteFill>
);

const NextSteps: React.FC<{ nextSteps: string[] }> = ({ nextSteps }) => (
  <AbsoluteFill
    style={{
      backgroundColor: BG,
      justifyContent: 'center',
      padding: '0 120px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}
  >
    <FadeIn>
      <div style={{ fontSize: 20, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 48 }}>
        Coming Next Week
      </div>
    </FadeIn>
    {nextSteps.map((s, i) => (
      <FadeIn key={i} delay={15 + i * 20}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ACCENT, marginRight: 20 }} />
          <div style={{ fontSize: 28, color: WHITE, lineHeight: 1.4 }}>{s}</div>
        </div>
      </FadeIn>
    ))}
  </AbsoluteFill>
);

const Outro: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundColor: BG,
      justifyContent: 'center',
      alignItems: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}
  >
    <FadeIn>
      <div style={{ fontSize: 48, color: WHITE, fontWeight: 700, marginBottom: 24 }}>
        Your Saiba Team
      </div>
    </FadeIn>
    <FadeIn delay={15}>
      <div style={{ fontSize: 22, color: MUTED }}>
        hello@saiba.dk — saiba.dk
      </div>
    </FadeIn>
  </AbsoluteFill>
);

export const WeeklyReport: React.FC<ReportProps> = (props) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={fps * 4}>
        <Intro clientName={props.clientName} date={props.date} weekNumber={props.weekNumber} />
      </Sequence>
      <Sequence from={fps * 4} durationInFrames={fps * 5}>
        <Summary metrics={props.metrics} />
      </Sequence>
      <Sequence from={fps * 9} durationInFrames={fps * 10}>
        <Highlights highlights={props.highlights} />
      </Sequence>
      <Sequence from={fps * 19} durationInFrames={fps * 6}>
        <NextSteps nextSteps={props.nextSteps} />
      </Sequence>
      <Sequence from={fps * 25} durationInFrames={fps * 5}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
