import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Radio, Save, X } from "lucide-react";
import type { CameraConfig } from "../domain/types";
import {
  type CameraDraft,
  createCameraConfig,
  resolveRtspStreamUri,
  updateCameraConfig,
  validateCameraDraft,
} from "../services/cameraService";

interface CameraDialogProps {
  camera?: CameraConfig;
  cameraIndex: number;
  initialDraft?: Partial<CameraDraft>;
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
  initialDraft,
  onClose,
  onSave,
}: CameraDialogProps) {
  const [draft, setDraft] = useState<CameraDraft>(emptyDraft);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [isResolvingRtsp, setIsResolvingRtsp] = useState(false);

  useEffect(() => {
    if (!camera) {
      setDraft({ ...emptyDraft, ...(initialDraft ?? {}) });
      setError("");
      setHint("");
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
    setError("");
    setHint("");
  }, [camera, initialDraft]);

  function updateField<K extends keyof CameraDraft>(
    key: K,
    value: CameraDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    setHint("");
  }

  async function handleResolveRtsp() {
    const validation = validateCameraDraft(draft);

    if (validation) {
      setError(validation);
      return null;
    }

    setIsResolvingRtsp(true);
    setError("");
    setHint("正在通过 ONVIF 获取 RTSP StreamUri...");

    try {
      const resolution = await resolveRtspStreamUri(draft);
      const nextDraft = { ...draft, rtspUrl: resolution.rtspUrl };
      setDraft(nextDraft);
      setHint(
        `${resolution.message} Profile: ${resolution.profileName || resolution.profileToken}`,
      );
      return nextDraft;
    } catch (resolveError) {
      const message =
        resolveError instanceof Error
          ? resolveError.message
          : "ONVIF 获取 RTSP 地址失败。";
      setError(`${message} 可手动填写 ODM 中显示的 RTSP 地址后保存。`);
      setHint("");
      return null;
    } finally {
      setIsResolvingRtsp(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateCameraDraft(draft);

    if (validation) {
      setError(validation);
      return;
    }

    let draftToSave = draft;
    if (!draft.rtspUrl.trim()) {
      const resolvedDraft = await handleResolveRtsp();
      if (!resolvedDraft) {
        return;
      }
      draftToSave = resolvedDraft;
    }

    onSave(
      camera
        ? updateCameraConfig(camera, draftToSave)
        : createCameraConfig(draftToSave, cameraIndex),
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
            <div className="input-with-button">
              <input
                value={draft.rtspUrl}
                onChange={(event) => updateField("rtspUrl", event.target.value)}
                placeholder="点击获取 RTSP，或填写 ODM 中显示的地址"
              />
              <button
                className="secondary-button"
                disabled={isResolvingRtsp}
                onClick={handleResolveRtsp}
                type="button"
              >
                {isResolvingRtsp ? (
                  <Loader2 className="spin" size={17} />
                ) : (
                  <Radio size={17} />
                )}
                获取 RTSP
              </button>
            </div>
          </label>

          {hint && <div className="form-hint full-width">{hint}</div>}
          {error && <div className="form-error full-width">{error}</div>}

          <div className="modal-actions full-width">
            <button className="secondary-button" onClick={onClose} type="button">
              取消
            </button>
            <button className="primary-button" disabled={isResolvingRtsp} type="submit">
              <Save size={17} />
              保存摄像机
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
