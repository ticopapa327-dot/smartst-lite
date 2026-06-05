import { PhoneCall, RadioTower, Smartphone, Tablet, Users } from "lucide-react";
import type { VideoChannel } from "../domain/mediaTypes";

interface CallPanelProps {
  defaultChannel?: VideoChannel;
}

export function CallPanel({ defaultChannel }: CallPanelProps) {
  return (
    <section className="hmi-panel call-panel">
      <div className="hmi-section-heading">
        <div>
          <span>Teaching Session</span>
          <h2>呼叫与媒体策略</h2>
        </div>
        <strong>PoC</strong>
      </div>

      <div className="policy-list">
        <div className="policy-item">
          <RadioTower size={18} />
          <div>
            <strong>{defaultChannel?.displayName ?? "未选择默认画面"}</strong>
            <span>连接建立后默认发布一路画面，不默认发布全部 4 路。</span>
          </div>
        </div>
        <div className="policy-item">
          <Smartphone size={18} />
          <div>
            <strong>手机 H5：单向收看</strong>
            <span>只订阅默认画面和手术室音频，由 LiveKit/SFU 承担并发转发。</span>
          </div>
        </div>
        <div className="policy-item">
          <Tablet size={18} />
          <div>
            <strong>Android 会议平板：正式客户端</strong>
            <span>按 tablet-watch / tablet-interactive token 策略入房。</span>
          </div>
        </div>
        <div className="policy-item">
          <Users size={18} />
          <div>
            <strong>人数限制</strong>
            <span>交互终端、会议平板、手机观察者分别计数。</span>
          </div>
        </div>
      </div>

      <div className="hmi-action-row">
        <button className="hmi-button primary" disabled type="button">
          <PhoneCall size={17} />
          呼叫示教室
        </button>
        <button className="hmi-button" disabled type="button">
          生成手机观看码
        </button>
      </div>
    </section>
  );
}

