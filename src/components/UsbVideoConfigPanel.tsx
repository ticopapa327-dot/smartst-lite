import { Link, RefreshCw, Usb, Video } from "lucide-react";
import type { ChangeEvent } from "react";
import type { VideoChannel } from "../domain/mediaTypes";
import type {
  NativeWorkerDevice,
  NativeWorkerVideoChannelBinding,
  NativeWorkerVideoChannelBindings,
} from "../services/nativeWorkerService";

interface UsbVideoConfigPanelProps {
  channels: VideoChannel[];
  videoDevices: NativeWorkerDevice[];
  bindings: NativeWorkerVideoChannelBindings;
  isProbing: boolean;
  probeMessage?: string;
  probeError?: string | null;
  onProbeDevices: () => void | Promise<void>;
  onBindingsChange: (bindings: NativeWorkerVideoChannelBindings) => void;
}

const roleLabels: Record<VideoChannel["role"], string> = {
  field: "术野",
  panorama: "全景",
  endoscope: "内镜",
  device: "医疗设备",
  auxiliary: "辅助",
};

export function UsbVideoConfigPanel({
  channels,
  videoDevices,
  bindings,
  isProbing,
  probeMessage,
  probeError,
  onProbeDevices,
  onBindingsChange,
}: UsbVideoConfigPanelProps) {
  const usbChannels = channels.filter(
    (channel) => channel.enabled && channel.kind === "usb",
  );
  const bindingCount = Object.keys(bindings).length;

  function updateBinding(
    channelId: string,
    binding: NativeWorkerVideoChannelBinding | null,
  ) {
    const nextBindings = { ...bindings };
    if (binding) {
      nextBindings[channelId] = binding;
    } else {
      delete nextBindings[channelId];
    }
    onBindingsChange(nextBindings);
  }

  function handleSelect(channelId: string, event: ChangeEvent<HTMLSelectElement>) {
    const binding = findDeviceBinding(event.target.value, videoDevices);
    updateBinding(channelId, binding);
  }

  return (
    <section className="hmi-panel usb-video-config-panel">
      <div className="hmi-section-heading">
        <div>
          <span>USB Video</span>
          <h2>USB 摄像机配置</h2>
        </div>
        <strong>
          {videoDevices.length} 路设备 / {bindingCount} 路绑定
        </strong>
      </div>

      <div className="usb-config-grid">
        {usbChannels.map((channel) => {
          const selectedValue = bindingToValue(bindings[channel.id]);
          const selectedDeviceVisible =
            !selectedValue ||
            videoDevices.some(
              (device, index) => deviceToValue(device, index) === selectedValue,
            );

          return (
            <label className="usb-config-row" key={channel.id}>
              <span className="usb-config-channel">
                <Video size={16} />
                <span>
                  <strong>{channel.displayName}</strong>
                  <small>
                    {roleLabels[channel.role]} / {channel.id}
                  </small>
                </span>
              </span>
              <select
                className="hmi-select"
                value={selectedValue}
                onChange={(event) => handleSelect(channel.id, event)}
              >
                <option value="">自动绑定</option>
                {selectedValue && !selectedDeviceVisible ? (
                  <option value={selectedValue}>已保存设备（当前未枚举）</option>
                ) : null}
                {videoDevices.map((device, index) => (
                  <option
                    key={deviceToValue(device, index)}
                    value={deviceToValue(device, index)}
                  >
                    {formatDeviceLabel(device, index)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      {probeError ? <div className="native-worker-alert">{probeError}</div> : null}

      <div className="hmi-action-row usb-config-actions">
        <button
          className="hmi-button primary"
          disabled={isProbing}
          onClick={() => void onProbeDevices()}
          type="button"
        >
          <RefreshCw size={15} />
          {isProbing ? "正在探测" : "探测 USB 设备"}
        </button>
        <span className="usb-config-status">
          <Usb size={15} />
          {probeMessage ?? "尚未探测"}
        </span>
        <span className="usb-config-status">
          <Link size={15} />
          {bindingCount > 0 ? "使用显式绑定启动采集" : "未绑定时使用枚举顺序"}
        </span>
      </div>
    </section>
  );
}

function findDeviceBinding(
  value: string,
  devices: NativeWorkerDevice[],
): NativeWorkerVideoChannelBinding | null {
  if (!value) {
    return null;
  }

  const selectedDevice = devices.find(
    (device, index) => deviceToValue(device, index) === value,
  );
  if (!selectedDevice) {
    return parseStoredBindingValue(value);
  }

  return {
    ...(typeof selectedDevice.index === "number"
      ? { index: selectedDevice.index }
      : {}),
    ...(selectedDevice.deviceId ? { deviceId: selectedDevice.deviceId } : {}),
    ...(selectedDevice.nativeId ? { nativeId: selectedDevice.nativeId } : {}),
  };
}

function parseStoredBindingValue(
  value: string,
): NativeWorkerVideoChannelBinding | null {
  const [kind, rawValue] = value.split(/:(.*)/s).filter(Boolean);
  if (!kind || !rawValue) {
    return null;
  }
  if (kind === "index") {
    const index = Number(rawValue);
    return Number.isInteger(index) ? { index } : null;
  }
  if (kind === "deviceId") {
    return { deviceId: rawValue };
  }
  if (kind === "nativeId") {
    return { nativeId: rawValue };
  }
  return null;
}

function bindingToValue(
  binding: NativeWorkerVideoChannelBinding | undefined,
): string {
  if (!binding) {
    return "";
  }
  if (binding.deviceId) {
    return `deviceId:${binding.deviceId}`;
  }
  if (typeof binding.index === "number") {
    return `index:${binding.index}`;
  }
  if (binding.nativeId) {
    return `nativeId:${binding.nativeId}`;
  }
  return "";
}

function deviceToValue(device: NativeWorkerDevice, fallbackIndex: number): string {
  if (device.deviceId) {
    return `deviceId:${device.deviceId}`;
  }
  if (typeof device.index === "number") {
    return `index:${device.index}`;
  }
  if (device.nativeId) {
    return `nativeId:${device.nativeId}`;
  }
  return `index:${fallbackIndex}`;
}

function formatDeviceLabel(device: NativeWorkerDevice, fallbackIndex: number): string {
  const indexLabel =
    typeof device.index === "number" ? `#${device.index}` : `#${fallbackIndex}`;
  const displayName =
    device.displayName ?? device.deviceId ?? device.nativeId ?? "未命名 USB 视频设备";
  const detail = device.deviceId ?? device.nativeId ?? device.backend;
  return detail
    ? `${indexLabel} ${displayName} (${detail})`
    : `${indexLabel} ${displayName}`;
}
