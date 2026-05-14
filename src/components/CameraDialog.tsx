import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Save, X } from "lucide-react";
import type { CameraConfig } from "../domain/types";
import {
  type CameraDraft,
  createCameraConfig,
  updateCameraConfig,
  validateCameraDraft,
} from "../services/cameraService";

interface CameraDialogProps {
  camera?: CameraConfig;
  cameraIndex: number;
  onClose: () => void;
  onSave: (camera: CameraConfig) => void;
}

const emptyDraft: CameraDraft = {
  name: "",
  ipAddress: "",
  onvifPort: "80",
  username: "",
  password: "",
  rtspUrl: "",
};

export function CameraDialog({
  camera,
  cameraIndex,
  onClose,
  onSave,
}: CameraDialogProps) {
  const [draft, setDraft] = useState<CameraDraft>(emptyDraft);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!camera) {
      setDraft(emptyDraft);
      return;
    }

    setDraft({
      name: camera.name,
      ipAddress: camera.ipAddress,
      onvifPort: camera.onvifPort,
      username: camera.username,
      password: camera.password,
      rtspUrl: camera.rtspUrl,
    });
  }, [camera]);

  function updateField<K extends keyof CameraDraft>(
    key: K,
    value: CameraDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateCameraDraft(draft);

    if (validation) {
      setError(validation);
      return;
    }

    onSave(
      camera
        ? updateCameraConfig(camera, draft)
        : createCameraConfig(draft, cameraIndex),
    );
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <h2>{camera ? "编辑摄像机" : "添加摄像机"}</h2>
            <p>最多支持 2 路 ONVIF 网络摄像机。</p>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭" type="button">
            <X size={18} />
          </button>
        </div>

        <form className="form-grid" onSubmit={handleSubmit}>
          <label>
            摄像机名称
            <input
              value={draft.name}
              onChange={(event) => updateField("name", event.target.value)}
              placeholder={`例如 摄像机 ${cameraIndex + 1}`}
            />
          </label>

          <label>
            IP 地址
            <input
              value={draft.ipAddress}
              onChange={(event) => updateField("ipAddress", event.target.value)}
              placeholder="例如 192.168.1.64"
            />
          </label>

          <label>
            ONVIF 端口
            <input
              value={draft.onvifPort}
              onChange={(event) => updateField("onvifPort", event.target.value)}
              placeholder="例如 80 或 2000"
            />
          </label>

          <label>
            用户名
            <input
              value={draft.username}
              onChange={(event) => updateField("username", event.target.value)}
              placeholder="例如 admin"
            />
          </label>

          <label>
            密码
            <input
              value={draft.password}
              onChange={(event) => updateField("password", event.target.value)}
              placeholder="本地保存，后续版本加密"
              type="password"
            />
          </label>

          <label className="full-width">
            RTSP 地址
            <input
              value={draft.rtspUrl}
              onChange={(event) => updateField("rtspUrl", event.target.value)}
              placeholder="留空时生成常见海康格式候选地址"
            />
          </label>

          {error && <div className="form-error full-width">{error}</div>}

          <div className="modal-actions full-width">
            <button className="secondary-button" onClick={onClose} type="button">
              取消
            </button>
            <button className="primary-button" type="submit">
              <Save size={17} />
              保存摄像机
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
