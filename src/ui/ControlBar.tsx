import { useApp } from '../store/appStore';

export default function ControlBar() {
  const playing = useApp((s) => s.playing);
  const play = useApp((s) => s.play);
  const pause = useApp((s) => s.pause);
  const stepForward = useApp((s) => s.stepForward);
  const stepBack = useApp((s) => s.stepBack);
  const reset = useApp((s) => s.reset);
  const seekTo = useApp((s) => s.seekTo);
  const currentStep = useApp((s) => s.currentStep);
  const maxStep = useApp((s) => s.maxStep);
  const speed = useApp((s) => s.speed);
  const setSpeed = useApp((s) => s.setSpeed);
  const runStatus = useApp((s) => s.runStatus);
  const errorMsg = useApp((s) => s.errorMsg);

  const busy = runStatus === 'compiling' || runStatus === 'running';
  const atEnd = currentStep >= maxStep && maxStep > 0;

  const statusLabel =
    runStatus === 'error'
      ? '错误'
      : runStatus === 'compiling'
        ? '编译中'
        : playing
          ? '播放中'
          : atEnd
            ? '已结束'
            : currentStep > 0 || maxStep > 0
              ? '就绪'
              : '未运行';

  const statusCls =
    runStatus === 'error' ? 'err' : runStatus === 'compiling' ? 'busy' : playing ? 'busy' : currentStep > 0 || maxStep > 0 ? 'ok' : '';

  return (
    <div className="controlbar">
      <button className="ctrl-btn big" onClick={playing ? pause : play} disabled={busy || maxStep === 0 || atEnd} title={playing ? '暂停' : '播放'}>
        {playing ? '⏸' : '▶'}
      </button>
      <button className="ctrl-btn" onClick={stepBack} disabled={busy || currentStep <= 0} title="单步后退">
        ⏮
      </button>
      <button className="ctrl-btn" onClick={stepForward} disabled={busy || atEnd} title="单步前进">
        ⏭
      </button>
      <button className="ctrl-btn" onClick={reset} title="重置到开头">
        ⟲
      </button>
      <div className="progress-row">
        <input
          type="range"
          min={0}
          max={Math.max(maxStep, 1)}
          value={currentStep}
          onChange={(e) => seekTo(Number(e.target.value))}
          disabled={busy || maxStep === 0}
          title="拖动跳转到任意步骤"
        />
        <span className="step-label">
          步骤 {currentStep} / {maxStep}
        </span>
      </div>
      <div className="speed-slider" title="播放速度">
        <span>速度</span>
        <input
          type="range"
          min={0.1}
          max={5}
          step={0.1}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
        <span style={{ width: 34 }}>{speed.toFixed(1)}x</span>
      </div>
      <span className={`status-pill ${statusCls}`}>{statusLabel}</span>
      {runStatus === 'error' && errorMsg && (
        <span style={{ color: 'var(--danger)', fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={errorMsg}>
          {errorMsg}
        </span>
      )}
    </div>
  );
}
