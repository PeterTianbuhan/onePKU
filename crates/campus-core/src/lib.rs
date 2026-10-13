use anyhow::{anyhow, bail, Result};
use pkuinfo_common::session::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
mod auth;
mod accounts;
mod bookings;
mod curriculum;
mod downloads;
mod haoxue;
mod maintenance;
mod materials;
mod news;
mod playback;
mod platform;
mod reminders;
mod storage;
mod study;
mod subtitles;
mod writes;
pub use downloads::safe_filename;
pub use study::CourseBrowserCookie;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Reminders,
    SetReminders {
        enabled: bool,
    },
    ReadReminders,
    Sessions,
    Snapshot,
    ClearCache,
    News {
        source: String,
        page: u32,
    },
    NewsDetail {
        source: String,
        id: String,
    },
    OpenNews {
        source: String,
        id: String,
    },
    /// 本院通知按手动选择的院系定位；门户登录打通前不做自动识别。
    Departments,
    /// 校内门户连接状态与识别到的院系（用来兜底判断本院）。
    PortalStatus,
    PortalDetect,
    PortalLogout,
    SetDepartment {
        value: String,
    },
    OpenLink {
        url: String,
    },
    CalendarPdf {
        year: String,
    },
    CurriculumPages {
        volume: String,
        from: u32,
        to: u32,
        title: String,
        open: bool,
    },
    Preferences,
    /// 课堂实录登录态：载荷由学校 app-login 页面交给原生桥，原样透传解析。
    HaoxueLogin {
        payload: Value,
    },
    HaoxueStatus,
    HaoxueLogout,
    /// 同名课程的候选（让用户认一次是哪一门）。
    HaoxueCandidates {
        name: String,
    },
    SetHaoxueCourse {
        name: String,
        id: String,
    },
    /// 统一认证完成后：以安卓身份重取中转页，用窗口 cookie 解出令牌。
    HaoxueRelay {
        url: String,
        cookies: Vec<(String, String)>,
    },
    /// 断开某个服务的登录：只清这个服务的会话与 cookie，其它服务不受影响。
    ServiceLogout {
        service: String,
    },
    /// 观看进度回写好学；`seconds` 是距上次上报的观看秒数。
    HaoxueRecord {
        course: String,
        episode: String,
        play_time: u64,
        seconds: u64,
    },
    /// 只能恢复默认；更改到某个目录必须经过桌面容器的系统选择框，前端不能传路径。
    ResetDownloadRoot,
    OpenDownloadRoot,
    /// 回放缓存位置；同样只由桌面容器的系统选择框更改。
    ResetCacheRoot,
    OpenCacheRoot,
    Profile,
    SetProfile {
        profile: Value,
    },
    /// 成绩口径（专业必修/限选的手动纳入与排除）。只存本机。
    GradesScope,
    SetGradesScope {
        scope: Value,
    },
    SubtitleSettings,
    SetSubtitleModel {
        model: String,
    },
    SetKeepAlive {
        enabled: bool,
    },
    Courses,
    AllCourses,
    OpenArchive {
        course: String,
    },
    LocalMaterials {
        course: String,
    },
    ReadLocalMaterial {
        course: String,
        id: String,
    },
    OpenLocalMaterial {
        course: String,
        id: String,
    },
    TrashLocalMaterial {
        course: String,
        id: String,
    },
    Videos {
        course: String,
    },
    SubtitleStatus {
        id: String,
    },
    SubtitleStart {
        id: String,
    },
    SubtitleCancel {
        id: String,
    },
    PlaybackPrepare {
        course: String,
        video: String,
        #[serde(default)]
        refresh: bool,
        #[serde(default)]
        position: f64,
    },
    PlaybackStatus {
        id: String,
    },
    PlaybackControl {
        id: String,
        downloading: bool,
    },
    PlaybackClose {
        id: String,
        #[serde(default)]
        clear: bool,
    },
    Recordings {
        date: String,
        search: String,
    },
    RecordingSessions {
        course: String,
    },
    LearningGrades {
        course: String,
    },
    Scores,
    Exams,
    CardStats {
        month: String,
        part: String,
    },
    Assignments,
    CourseAssignments {
        course: String,
    },
    PrepareSubmission {
        course: String,
        content: String,
        file: String,
    },
    CommitSubmission {
        id: String,
    },
    RecheckSubmission {
        id: String,
    },
    EndSubmission {
        id: String,
    },
    DiscardStage {
        id: String,
    },
    WriteOperations,
    OpenAssignment {
        course: String,
        content: String,
    },
    Notices,
    CourseNotices {
        course: String,
    },
    AssignmentFeedback {
        course: String,
        content: String,
    },
    Timetable,
    Card,
    Transactions {
        page: u32,
    },
    Content {
        course: String,
    },
    Holes {
        page: u32,
        search: String,
    },
    Hole {
        id: i64,
    },
    Rooms {
        building: String,
        day: String,
    },
    BookingGrid {
        building: String,
        date: String,
    },
    BookingApplications,
    Calendar,
    /// 账号密码登录：`services` 为空时一次换回四个服务的会话，与安卓端一致。
    /// 密码只在本次调用里存在：不进缓存键，也不写进本机快照。
    AuthPassword {
        username: String,
        password: String,
        #[serde(default)]
        services: Vec<String>,
        otp: Option<String>,
        /// 记住就写进系统加密存储；不记就清掉之前记住的。
        #[serde(default)]
        remember: bool,
    },
    /// 本机是否记住了统一认证账号（只回账号，不回密码）。
    Credentials,
    SaveCredentials {
        username: String,
        password: String,
        remember: bool,
    },
    ClearCredentials,
    AuthBegin {
        service: String,
    },
    AuthPoll {
        id: String,
    },
    AuthCancel {
        id: String,
    },
    SmsSend {
        scope: String,
    },
    SmsVerify {
        scope: String,
        code: String,
    },
    Downloads,
    DownloadBatch {
        ids: Vec<String>,
    },
    DownloadVideo {
        course: String,
        video: String,
    },
    Download {
        id: String,
    },
    DownloadStatus {
        id: String,
    },
    DownloadCancel {
        id: String,
    },
    DownloadRetry {
        id: String,
    },
    Open {
        target: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub data: Option<Value>,
    pub updated_at: Option<String>,
    pub stale: bool,
    pub error: Option<Problem>,
    pub warnings: Vec<String>,
    pub generation: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Problem {
    pub code: String,
    pub message: String,
}
#[derive(Default)]
pub struct Core {
    subtitles: Mutex<subtitles::SubtitleStore>,
    subtitle_account_lock: tokio::sync::Mutex<()>,
    course_account_lock: tokio::sync::Mutex<()>,
    materials_lock: Mutex<()>,
    playback: Mutex<playback::PlaybackStore>,
    playback_prepare_lock: tokio::sync::Mutex<()>,
    reminder_lock: Mutex<()>,
    persist_lock: Mutex<()>,
    writes: Mutex<writes::WriteState>,
    write_runtime: Mutex<Option<std::fs::File>>,
    cache: Mutex<HashMap<String, Envelope>>,
    course: Mutex<Option<(String, pku_course::api::CourseApi)>>,
    health: Mutex<HashMap<String, maintenance::Health>>,
    keep_alive: std::sync::atomic::AtomicBool,
    auth: Mutex<HashMap<String, auth::Attempt>>,
    files: Mutex<HashMap<String, downloads::FileRef>>,
    jobs: Mutex<HashMap<String, downloads::Job>>,
    download_queue: Mutex<Option<std::sync::mpsc::SyncSender<downloads::Task>>>,
}
fn owner(req: &Request) -> &'static str {
    match req {
        Request::BookingGrid { .. } | Request::BookingApplications => "bdkj",
        Request::Download { .. }
        | Request::DownloadStatus { .. }
        | Request::DownloadRetry { .. }
        | Request::DownloadBatch { .. }
        | Request::OpenArchive { .. }
        | Request::LocalMaterials { .. }
        | Request::ReadLocalMaterial { .. }
        | Request::OpenLocalMaterial { .. }
        | Request::TrashLocalMaterial { .. }
        | Request::SubtitleStatus { .. }
        | Request::SubtitleStart { .. }
        | Request::SubtitleCancel { .. }
        | Request::PlaybackPrepare { .. }
        | Request::PlaybackStatus { .. }
        | Request::PlaybackControl { .. }
        | Request::PlaybackClose { .. }
        | Request::DownloadVideo { .. }
        | Request::PrepareSubmission { .. }
        | Request::CommitSubmission { .. }
        | Request::RecheckSubmission { .. }
        | Request::EndSubmission { .. }
        | Request::DiscardStage { .. }
        | Request::WriteOperations
        | Request::OpenAssignment { .. }
        | Request::Courses
        | Request::AllCourses
        | Request::HaoxueRecord { .. }
        | Request::Recordings { .. }
        | Request::RecordingSessions { .. }
        | Request::LearningGrades { .. }
        | Request::CourseAssignments { .. }
        | Request::Assignments
        | Request::Notices
        | Request::CourseNotices { .. }
        | Request::AssignmentFeedback { .. }
        | Request::Content { .. } => "course",
        Request::Scores
        | Request::Exams
        | Request::Timetable
        | Request::Holes { .. }
        | Request::Hole { .. } => "treehole",
        Request::CardStats { .. } | Request::Card | Request::Transactions { .. } => "campuscard",
        _ => "public",
    }
}
/// 会话过期时允许自动重登再重试的，只有重复一次没有副作用的读取；写操作和负责
/// 打开窗口的请求一律排除。课程表不落快照，但同样是换不到票就要人工登录的读取。
fn may_relogin(req: &Request, service: &str) -> bool {
    matches!(service, "course" | "treehole" | "campuscard" | "bdkj")
        && (storage::cacheable(req) || matches!(req, Request::Timetable))
}
/// 快照键的前缀是当前账号基准；静默续期把基准换掉之后要按新基准重建同一个键。
/// 密码登录的键里不能带凭证，只记账号与目标服务。
fn request_key(req: &Request, generation: &str) -> String {
    match req {
        Request::AuthPassword {
            username, services, ..
        } => format!("{generation}:authPassword:{username}:{services:?}"),
        Request::SaveCredentials { username, .. } => {
            format!("{generation}:saveCredentials:{username}")
        }
        other => format!("{generation}:{}", serde_json::to_string(other).unwrap()),
    }
}
pub fn fingerprint(service: &str) -> String {
    if service == "public" {
        return "public".into();
    }
    let b = Store::new(service)
        .and_then(|s| Ok(std::fs::read(s.session_path())?))
        .unwrap_or_default();
    let mut hash = Sha256::new();
    hash.update(&b);
    format!("{:x}", hash.finalize())
}
fn problem(e: anyhow::Error) -> Problem {
    let s = format!("{e:#}");
    if let Some(message) = s.strip_prefix("LOCAL_MATERIAL:") {
        return Problem {
            code: "localMaterial".into(),
            message: message.trim().into(),
        };
    }
    let (code, message) = if s.contains("BDKJ_BOOKING_CLOSED") {
        (
            "bookingClosed",
            "学校当前未开放研讨教室预约申请，请等待学校开放后再查询",
        )
    } else if s.contains("BDKJ_PROFILE_REQUIRED") {
        (
            "bookingProfile",
            "学校要求先完善联系电话和联系邮箱，完成后即可重新查询时段",
        )
    } else if s.contains("RECORDING_AUTH") {
        (
            "recordingAuth",
            "课堂实录会话需要重新建立，请打开实录原站核对",
        )
    } else if s.contains("COURSE_SMS_REQUIRED") || s.contains("40077") {
        ("courseSms", "课表需要短信验证")
    } else if s.contains("40002") {
        ("sms", "树洞需要短信验证")
    } else if s.contains("EXAMS_SOURCE_UNAVAILABLE") {
        ("noExams", "学校考试数据源当前不可用，请到校内门户核对")
    } else if s.contains("TIMETABLE_SOURCE_UNAVAILABLE") {
        ("noTimetable", "学校课表服务未返回课程数据，可稍后刷新")
    } else if (s.starts_with("好学") || s.contains("课堂实录"))
        && [
            "未登录",
            "登录已失效",
            "登录失效",
            "令牌",
            "401",
        ]
        .iter()
        .any(|needle| s.contains(needle))
    {
        // 课堂实录的登录失效不能报成通用「auth」：那会把用户引去重新登录教学网，
        // 播放器里的「重试」也只是再撞一次 401。
        (
            "haoxueAuth",
            "课堂实录登录已失效，请重新连接课堂实录",
        )
    } else if s.contains("未登录")
        || s.contains("过期")
        || s.contains("401")
        || s.contains("40001")
        || s.contains("登录失效")
        || s.contains("登录已失效")
    {
        ("auth", "登录已失效，请重新登录")
    } else if s.contains("timed out") || s.contains("超时") || s.contains("elapsed") {
        ("timeout", "响应超时，可以稍后重试")
    } else if [
        "请选择不超过",
        "文件超出",
        "待提交文件过多",
        "请重新选择文件",
        "请刷新今日作业",
        "已有提交记录",
        "此作业有待处理",
        "准备已过期",
        "暂存文件已变化",
        "提交仍在进行",
        "操作记录已满",
        "请在 OnePKU",
        "教师说明本作业",
    ]
    .iter()
    .any(|prefix| s.starts_with(prefix))
    {
        ("validation", s.as_str())
    } else if s.contains("同名课程") {
        ("haoxueAmbiguous", s.as_str())
    } else if s.starts_with("课堂实录") || s.starts_with("好学") {
        // 好学侧的报错本来就是给用户看的：同名候选、未收录等，不能抹成通用文案。
        ("haoxue", s.as_str())
    } else if s.contains("filename") || s.contains("文件名") {
        ("invalid", "这个文件名无法保存")
    } else {
        ("unavailable", "暂时无法获取，请刷新重试或打开原网站")
    };
    Problem {
        code: code.into(),
        message: message.into(),
    }
}
impl Core {
    /// 由桌面容器在用户通过系统对话框选好文件夹后调用。
    pub fn set_download_root(&self, path: &std::path::Path) -> Result<Value> {
        downloads::set_download_root(Some(path))
    }
    pub fn set_cache_root(&self, path: &std::path::Path) -> Result<Value> {
        downloads::set_cache_root(Some(path))
    }

    pub fn call(self: &Arc<Self>, req: Request) -> Envelope {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(self.execute(req))
    }
    async fn execute(self: &Arc<Self>, req: Request) -> Envelope {
        let service = owner(&req);
        let mut generation = fingerprint(service);
        let mut key = request_key(&req, &generation);
        let mut result = tokio::time::timeout(Duration::from_secs(75), self.dispatch(&req))
            .await
            .map_err(|_| anyhow!("超时"))
            .and_then(|v| v);
        // 会话过期就用在手钥匙串里的账号静默换一次票再重试；写操作绝不自动重放。
        let expired = result
            .as_ref()
            .err()
            .map(|e| problem(anyhow!("{e}")))
            .is_some_and(|p| p.code == "auth");
        if expired && may_relogin(&req, service) && self.relogin(service).await.is_ok() {
            // 换票改写了 session.json，基准得跟着挪到新的那份：这是我们自己替用户续的会话，
            // 不是切账号。继续按旧基准走就会被当成「账号已更新」，把刚取到的数据丢掉。
            generation = fingerprint(service);
            key = request_key(&req, &generation);
            result = tokio::time::timeout(Duration::from_secs(75), self.dispatch(&req))
                .await
                .map_err(|_| anyhow!("超时"))
                .and_then(|v| v);
        }
        if generation != fingerprint(service) {
            return Envelope {
                data: None,
                updated_at: None,
                stale: false,
                error: Some(Problem {
                    code: "changed".into(),
                    message: "账号已更新，请刷新".into(),
                }),
                warnings: vec![],
                generation: fingerprint(service),
            };
        }
        let mut cache = self.cache.lock().unwrap();
        let mut out = match result {
            Ok((data, warnings)) => Envelope {
                data: Some(data),
                updated_at: Some(chrono::Utc::now().to_rfc3339()),
                stale: false,
                error: None,
                warnings,
                generation,
            },
            Err(e) => {
                let mut old = cache.get(&key).cloned().unwrap_or(Envelope {
                    data: None,
                    updated_at: None,
                    stale: false,
                    error: None,
                    warnings: vec![],
                    generation,
                });
                old.stale = old.data.is_some();
                old.error = Some(problem(e));
                old
            }
        };
        // Authentication failures must not continue displaying private stale content.
        if out
            .error
            .as_ref()
            .is_some_and(|e| matches!(e.code.as_str(), "auth" | "sms" | "courseSms"))
        {
            out.data = None;
            out.stale = false;
            out.updated_at = None;
            cache.retain(|k, _| {
                k.split_once(':')
                    .and_then(|(_, j)| serde_json::from_str::<Request>(j).ok())
                    .is_none_or(|r| owner(&r) != service)
            });
        }
        if matches!(
            req,
            Request::AuthPoll { .. } | Request::SmsVerify { .. } | Request::AuthPassword { .. }
        )
            && out.data.as_ref().is_some_and(|d| d["state"] == "success")
        {
            cache.clear();
        }
        if out.error.is_none()
            && matches!(
                req,
                Request::Courses
                    | Request::AllCourses
                    | Request::Videos { .. }
                    | Request::Scores
                    | Request::Exams
                    | Request::CardStats { .. }
                    | Request::Recordings { .. }
                    | Request::RecordingSessions { .. }
                    | Request::LearningGrades { .. }
                    | Request::CourseAssignments { .. }
                    | Request::Assignments
                    | Request::Notices
                    | Request::Timetable
                    | Request::Card
                    | Request::Transactions { .. }
                    | Request::Content { .. }
                    | Request::Holes { .. }
                    | Request::Hole { .. }
                    | Request::Rooms { .. }
                    | Request::Calendar
                    | Request::CalendarPdf { .. }
                    | Request::News { .. }
                    | Request::NewsDetail { .. }
            )
        {
            if cache.len() > 96 {
                cache.clear()
            }
            cache.insert(key, out.clone());
        }
        drop(cache);
        if storage::cacheable(&req) {
            if let Err(_) = self.persist_cache() {
                out.warnings.push("本次更新尚未保存到本地缓存".into());
            }
        }
        if service != "public" {
            self.record_health(service, &out);
        }
        out
    }
    async fn dispatch(self: &Arc<Self>, req: &Request) -> Result<(Value, Vec<String>)> {
        let mut warnings = vec![];
        let data = match req {
            Request::BookingGrid { building, date } => self.booking_grid(building, date).await?,
            Request::BookingApplications => serde_json::to_value(
                pku_bdkj::api::BdkjApi::from_session()?
                    .list_applications()
                    .await?,
            )?,
            Request::Reminders => self.reminders()?,
            Request::SetReminders { enabled } => self.set_reminders(*enabled)?,
            Request::ReadReminders => self.read_reminders()?,
            Request::Sessions => self.sessions(),
            Request::Snapshot => self.snapshot(),
            Request::ClearCache => {
                self.clear_cache()?;
                json!({"cleared":true})
            }
            Request::News { source, page } => news::list(source, *page).await?,
            Request::NewsDetail { source, id } => {
                let item = self.news_item(source, id)?;
                news::detail(source, &item).await?
            }
            Request::OpenNews { source, id } => {
                let item = self.news_item(source, id)?;
                news::open_item(source, &item)?;
                json!({"opened":true})
            }
            Request::Departments => news::department_state(),
            Request::PortalStatus => news::portal_status().await?,
            Request::PortalDetect => news::portal_detect().await?,
            Request::PortalLogout => news::portal_logout()?,
            Request::ServiceLogout { service } => Self::service_logout(service)?,
            Request::HaoxueRelay { url, cookies } => haoxue::relay_login(url, cookies).await?,
            Request::HaoxueCandidates { name } => haoxue::candidates(name).await?,
            Request::SetHaoxueCourse { name, id } => haoxue::set_course(name, id)?,
            Request::SetDepartment { value } => news::set_department(value)?,
            Request::CalendarPdf { year } => news::calendar_pdf(year).await?,
            Request::CurriculumPages {
                volume,
                from,
                to,
                title,
                open,
            } => curriculum::pages(volume, *from, *to, title, *open).await?,
            Request::OpenLink { url } => {
                news::open_link(url)?;
                json!({"opened":true})
            }
            Request::SubtitleSettings => self.subtitle_settings()?,
            Request::SetSubtitleModel { model } => self.set_subtitle_model(model)?,
            Request::Preferences => {
                let mut v = downloads::download_root_info();
                let cache = downloads::cache_root_info();
                for key in ["cacheRoot", "cacheRootIsDefault"] {
                    v[key] = cache[key].clone();
                }
                v["keepAlive"] = json!(self.keep_alive.load(std::sync::atomic::Ordering::Relaxed));
                v
            }
            Request::HaoxueLogin { payload } => haoxue::save_session(payload)?,
            Request::HaoxueStatus => haoxue::status(),
            Request::HaoxueLogout => {
                haoxue::clear_session()?;
                json!({ "connected": false })
            }
            Request::HaoxueRecord {
                course,
                episode,
                play_time,
                seconds,
            } => haoxue::record(course, episode, *play_time, *seconds).await?,
            Request::ResetDownloadRoot => downloads::set_download_root(None)?,
            Request::OpenDownloadRoot => {
                let dir = downloads::download_root()?;
                std::fs::create_dir_all(&dir)?;
                platform::open(dir.as_os_str())?;
                json!({"opened":true})
            }
            Request::ResetCacheRoot => downloads::set_cache_root(None)?,
            Request::OpenCacheRoot => {
                let dir = downloads::cache_root()?;
                std::fs::create_dir_all(&dir)?;
                platform::open(dir.as_os_str())?;
                json!({"opened":true})
            }
            Request::SetKeepAlive { enabled } => {
                self.save_preference(*enabled)?;
                json!({"keepAlive":enabled})
            }
            Request::GradesScope => Self::grades_scope(),
            Request::SetGradesScope { scope } => self.save_grades_scope(scope)?,
            Request::Profile => self.profile()?,
            Request::SetProfile { profile } => self.save_profile(profile)?,
            Request::OpenArchive { course } => {
                let dir = self.material_directory(course).await?;
                platform::open(dir.as_os_str())?;
                json!({"opened":true})
            }
            Request::LocalMaterials { course } => self.local_materials(course).await?,
            Request::ReadLocalMaterial { course, id } => self.read_local_material(course, id).await?,
            Request::OpenLocalMaterial { course, id } => {
                self.open_local_material(course, id).await?
            }
            Request::TrashLocalMaterial { course, id } => {
                self.trash_local_material(course, id).await?
            }
            Request::AllCourses => self.all_courses().await?,
            Request::Videos { course } => self.videos(course, &mut warnings).await?,
            Request::PlaybackPrepare {
                course,
                video,
                refresh,
                position,
            } => self.playback_prepare(course, video, *refresh, *position).await?,
            Request::SubtitleStatus { id } => self.subtitle_status(id)?,
            Request::SubtitleStart { id } => self.subtitle_start(id)?,
            Request::SubtitleCancel { id } => self.subtitle_cancel(id)?,
            Request::PlaybackStatus { id } => self.playback_status(id)?,
            Request::PlaybackControl { id, downloading } => {
                self.playback_control(id, *downloading)?
            }
            Request::PlaybackClose { id, clear } => self.playback_close(id, *clear)?,
            Request::Recordings { date, search } => {
                serde_json::to_value(self.course_api()?.recordings_on(date, search).await?)?
            }
            Request::RecordingSessions { course } => {
                serde_json::to_value(self.course_api()?.recording_sessions(course).await?)?
            }
            Request::LearningGrades { course } => {
                self.find_course(course).await?;
                serde_json::to_value(self.course_api()?.learning_grades(course).await?)?
            }
            Request::Scores => serde_json::to_value(
                pku_treehole::api::TreeholeApi::from_session_noninteractive()
                    .await?
                    .get_scores()
                    .await?,
            )?,
            Request::Exams => self.exams().await?,
            Request::CardStats { month, part } => self.card_stats(month, part).await?,
            Request::Courses => {
                let a = self.course_api()?;
                json!(a
                    .list_courses(true)
                    .await?
                    .iter()
                    .map(study::course_value)
                    .collect::<Vec<_>>())
            }
            Request::PrepareSubmission {
                course,
                content,
                file,
            } => self.prepare_submission(course, content, file).await?,
            Request::CommitSubmission { id } => self.commit_submission(id).await?,
            Request::RecheckSubmission { id } => self.recheck_submission(id).await?,
            Request::EndSubmission { id } => self.end_submission(id)?,
            Request::DiscardStage { id } => self.discard_stage(id)?,
            Request::WriteOperations => self.write_operations()?,
            Request::OpenAssignment { course, content } => {
                valid_id(course)?;
                valid_id(content)?;
                news::open_link(&format!("https://course.pku.edu.cn/webapps/assignment/uploadAssignment?mode=view&course_id={course}&content_id={content}"))?;
                json!({"opened":true})
            }
            Request::CourseAssignments { course } => {
                self.course_assignments(course, &mut warnings).await?
            }
            Request::CourseNotices { course } => self.course_notices(course).await?,
            Request::AssignmentFeedback { course, content } => {
                self.assignment_feedback(course, content, &mut warnings)
                    .await?
            }
            Request::Assignments | Request::Notices => {
                let a = self.course_api()?;
                let courses = a.list_courses(true).await?;
                let results = futures::future::join_all(courses.iter().map(|c| async {
                    let r = tokio::time::timeout(Duration::from_secs(55), async {
                        if matches!(req, Request::Assignments) {
                            Ok::<_, anyhow::Error>(serde_json::to_value(
                                a.list_assignments_for_course(c).await?,
                            )?)
                        } else {
                            Ok(serde_json::to_value(
                                a.list_announcements_for_course(c).await?,
                            )?)
                        }
                    })
                    .await;
                    (c.name().to_string(), r)
                }))
                .await;
                let mut rows = vec![];
                let mut succeeded = 0;
                for (name, res) in results {
                    match res {
                        Ok(Ok(Value::Array(mut items))) => {
                            succeeded += 1;
                            for row in &mut items {
                                if let Some(c) = courses.iter().find(|c| {
                                    row["course_id"].as_str() == Some(c.id.as_str())
                                }) {
                                    study::apply_course_metadata(row, &study::course_value(c));
                                }
                            }
                            rows.extend(items)
                        }
                        _ => warnings.push(format!("{name} 未能更新")),
                    }
                }
                if succeeded == 0 && !courses.is_empty() {
                    bail!("所有课程读取失败")
                }
                for row in &rows {
                    if row["detail_error"] == true {
                        warnings.push(format!(
                            "{}：{} 的详情或提交状态未能获取",
                            row["course_name"].as_str().unwrap_or("课程"),
                            row["title"].as_str().unwrap_or("作业")
                        ));
                    }
                }
                self.register_files(&mut rows);
                json!(rows)
            }
            Request::Content { course } => {
                valid_id(course)?;
                let a = self.course_api()?;
                let metadata = self.find_course(course).await?;
                let mut rows = a
                    .list_all_content_recursive(course)
                    .await?
                    .into_iter()
                    .map(|v| serde_json::to_value(v).unwrap())
                    .collect::<Vec<_>>();
                for row in &mut rows {
                    row["course_name"] = metadata["name"].clone();
                    row["course_id"] = json!(course);
                    row["semester"] = metadata["semester"].clone();
                }
                self.register_files(&mut rows);
                json!(rows)
            }
            Request::Timetable => {
                let a = pku_treehole::api::TreeholeApi::from_session_noninteractive().await?;
                let rows = a.get_coursetable().await?;
                let times = match a.get_class_times().await {
                    Ok(v) => serde_json::to_value(v)?,
                    Err(_) => {
                        warnings.push("节次时间暂不可用".into());
                        json!([])
                    }
                };
                json!({"rows":rows,"times":times})
            }
            Request::Holes { page, search } => {
                page_valid(*page)?;
                if search.chars().count() > 100 {
                    bail!("search too long")
                };
                let a = pku_treehole::api::TreeholeApi::from_session_noninteractive().await?;
                if search.trim().is_empty() {
                    serde_json::to_value(a.list_holes(*page, 20).await?)?
                } else {
                    serde_json::to_value(a.search(search.trim(), *page, 20).await?)?
                }
            }
            Request::Hole { id } => {
                if *id < 1 {
                    bail!("invalid id")
                };
                serde_json::to_value(
                    pku_treehole::api::TreeholeApi::from_session_noninteractive()
                        .await?
                        .get_hole(*id)
                        .await?,
                )?
            }
            Request::Card => {
                let a = pku_campuscard::api::CardApi::new(&maintenance::card_token()?)?;
                json!(a.query_card().await?.card.iter().map(|c|json!({"name":c.cardname,"balance":c.elec_accamt,"lost":c.lostflag!=0,"frozen":c.freezeflag!=0,"expires":c.expdate})).collect::<Vec<_>>())
            }
            Request::Transactions { page } => {
                page_valid(*page)?;
                let a = pku_campuscard::api::CardApi::new(&maintenance::card_token()?)?;
                serde_json::to_value(a.get_turnovers(*page as i64, 20, None, None, None).await?)?
            }
            Request::Rooms { building, day } => {
                let d = pku_portal::freeclassroom::Day::parse(day)?;
                json!(pku_portal::freeclassroom::query(building, d)
                    .await?
                    .iter()
                    .map(|r| json!({"room":r.room,"capacity":r.cap,"occupied":r.slots()}))
                    .collect::<Vec<_>>())
            }
            Request::Calendar => json!(pku_portal::calendar::fetch()
                .await?
                .iter()
                .map(|c| json!({"year":c.year,"first":c.first_semester,"second":c.second_semester}))
                .collect::<Vec<_>>()),
            Request::AuthPassword {
                username,
                password,
                services,
                otp,
                remember,
            } => {
                self.auth_password(services, username, password, otp.as_deref(), *remember)
                    .await?
            }
            Request::Credentials => Self::credentials_status(),
            Request::SaveCredentials {
                username,
                password,
                remember,
            } => Self::set_credentials(username, password, *remember)?,
            Request::ClearCredentials => Self::clear_credentials()?,
            Request::AuthBegin { service } => self.auth_begin(service).await?,
            Request::AuthPoll { id } => self.auth_poll(id).await?,
            Request::AuthCancel { id } => {
                self.auth.lock().unwrap().remove(id);
                json!({"cancelled":true})
            }
            Request::SmsSend { scope } => self.sms(scope, None).await?,
            Request::SmsVerify { scope, code } => self.sms(scope, Some(code)).await?,
            Request::Downloads => self.downloads(),
            Request::DownloadBatch { ids } => self.download_batch(ids)?,
            Request::DownloadVideo { course, video } => self.download_video(course, video).await?,
            Request::Download { id } => self.download(id)?,
            Request::DownloadStatus { id } => self.download_status(id)?,
            Request::DownloadCancel { id } => self.download_cancel(id)?,
            Request::DownloadRetry { id } => self.download_retry(id).await?,
            Request::Open { target } => {
                let url = official_target(target)?;
                platform::open(std::ffi::OsStr::new(url))?;
                json!({"opened":true})
            }
        };
        Ok((data, warnings))
    }
}
fn valid_id(s: &str) -> Result<()> {
    if s.len() > 64 || s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bail!("invalid id")
    }
    Ok(())
}
fn page_valid(p: u32) -> Result<()> {
    if !(1..=10000).contains(&p) {
        bail!("invalid page")
    }
    Ok(())
}
pub fn official_target(s: &str) -> Result<&'static str> {
    Ok(match s {
        "course" => "https://course.pku.edu.cn",
        "treehole" => "https://treehole.pku.edu.cn",
        "timetable" => "https://treehole.pku.edu.cn/web/timetable",
        // 校园卡原站是门户站；bdcard 只是接口域名，直接打开会被拒（403）。
        "campuscard" => "https://card.pku.edu.cn/",
        "portal" => "https://portal.pku.edu.cn",
        "elective" => "https://elective.pku.edu.cn/elective2008/",
        "recordings" => "https://onlineroomse.pku.edu.cn/",
        "sports" => "https://epe.pku.edu.cn/venue/PKU",
        "bdkj" => "https://bdkj.pku.edu.cn/classRoom",
        "bdkjProfile" => "https://bdkj.pku.edu.cn/personal",
        "library" => "https://kjyy.lib.pku.edu.cn/",
        "calendar" => "https://simso.pku.edu.cn/pages/ccSchoolCalendar.html",
        _ => bail!("invalid target"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn beijing_deadline_is_absolute() {
        let a = pku_course::api::parse_deadline("2026年9月9日 星期三 下午11:59").unwrap();
        assert_eq!(
            a.with_timezone(&chrono::Utc).to_rfc3339(),
            "2026-09-09T15:59:00+00:00"
        );
        let b = pku_course::api::parse_deadline("2026年9月9日 星期三 上午12:00").unwrap();
        assert_eq!(
            b.with_timezone(&chrono::Utc).to_rfc3339(),
            "2026-09-08T16:00:00+00:00"
        )
    }
    #[test]
    fn invalid_download_names_rejected() {
        for s in ["../x", "/tmp/x", "..", "a/b", "a\\b", "a:b", "a\n"] {
            assert!(safe_filename(s).is_err(), "{s}");
        }
        assert_eq!(safe_filename("讲义 1.pdf").unwrap(), "讲义 1.pdf")
    }
    #[test]
    fn commands_and_links_are_allowlisted() {
        assert!(serde_json::from_value::<Request>(json!({"kind":"shell","cmd":"id"})).is_err());
        assert!(official_target("https://evil.test").is_err());
        assert!(official_target("portal").is_ok());
        assert!(valid_id("x&mode=delete").is_err());
    }
    #[test]
    fn replay_requests_are_named_and_split() {
        // 前端用的 kind 字符串与 Rust 字段名必须成对，写错就是静默失效。
        let list: Request =
            serde_json::from_value(json!({ "kind": "videos", "course": "量子力学" })).unwrap();
        assert!(matches!(list, Request::Videos { .. }));
        // 回放只归课堂实录，不再要求教学网会话。
        assert_eq!(owner(&list), "public");
        assert!(storage::cacheable(&list));
        // 「按课程」「按日期」的原始目录不再对外提供：回放只从课程页那一份列表进。
        for kind in [
            json!({"kind": "haoxueCourses", "page": 2, "search": "高等数学"}),
            json!({"kind": "haoxueByDate", "date": "2026-03-01", "page": 1}),
            json!({"kind": "haoxueEpisodes", "course": "123"}),
        ] {
            assert!(serde_json::from_value::<Request>(kind).is_err());
        }
        // 进度回写是出站写操作：不进缓存，也少一个字段都不收。
        let write = serde_json::from_value::<Request>(json!({
            "kind": "haoxueRecord", "course": "1", "episode": "2", "playTime": 90, "seconds": 30
        }))
        .unwrap();
        assert!(!storage::cacheable(&write));
        assert!(serde_json::from_value::<Request>(json!({"kind": "haoxueRecord", "course": "1"}))
            .is_err());
    }
    #[test]
    fn password_login_is_named_and_never_cached() {
        let login = serde_json::from_value::<Request>(json!({
            "kind": "authPassword", "username": "2200000000",
            "password": "secret", "services": ["course"]
        }))
        .unwrap();
        assert!(matches!(login, Request::AuthPassword { .. }));
        // 凭证不能进本机快照，也不能被当成可缓存的读取。
        assert!(!storage::cacheable(&login));
        assert!(matches!(
            login,
            Request::AuthPassword {
                remember: false,
                ..
            }
        ));
        for kind in [
            json!({ "kind": "credentials" }),
            json!({ "kind": "clearCredentials" }),
            json!({
                "kind": "saveCredentials", "username": "a", "password": "b", "remember": true
            }),
        ] {
            let request = serde_json::from_value::<Request>(kind).unwrap();
            assert!(!storage::cacheable(&request));
        }
        // 一次登录全部服务时 services 可以省略；账号或密码缺了就不收。
        assert!(serde_json::from_value::<Request>(json!({
            "kind": "authPassword", "username": "a", "password": "b"
        }))
        .is_ok());
        assert!(serde_json::from_value::<Request>(json!({
            "kind": "authPassword", "username": "a"
        }))
        .is_err());
    }
    #[test]
    fn haoxue_course_picks_are_named_and_not_cached() {
        for kind in [
            json!({ "kind": "haoxueCandidates", "name": "量子力学" }),
            json!({ "kind": "setHaoxueCourse", "name": "量子力学", "id": "c1" }),
        ] {
            let request = serde_json::from_value::<Request>(kind).unwrap();
            assert!(!storage::cacheable(&request));
        }
        // 同名歧义要能落到专门的 code，前端据此展示候选而不是报错。
        let problem = problem(anyhow!("课堂实录有 3 门同名课程，需要人工确认是哪一门"));
        assert_eq!(problem.code, "haoxueAmbiguous");
    }
    #[test]
    fn only_idempotent_session_reads_may_relogin() {
        // Request 里带着密码，测试失败时只回显 kind，不要把这个枚举做成 Debug。
        for kind in [
            json!({ "kind": "assignments" }),
            json!({ "kind": "card" }),
            json!({ "kind": "timetable" }),
        ] {
            let request = serde_json::from_value::<Request>(kind.clone()).unwrap();
            assert!(
                may_relogin(&request, owner(&request)),
                "会话过期时读取要自动重登：{kind}"
            );
        }
        // 重放写请求就是二次提交，打开原站窗口的请求也不需要会话。
        for (kind, service) in [
            (json!({ "kind": "commitSubmission", "id": "x" }), "course"),
            (
                json!({ "kind": "openAssignment", "course": "c", "content": "x" }),
                "course",
            ),
            (json!({ "kind": "news", "source": "s", "page": 1 }), "public"),
        ] {
            let request = serde_json::from_value::<Request>(kind.clone()).unwrap();
            assert!(!may_relogin(&request, service), "不能自动重放：{kind}");
        }
    }
    #[test]
    fn service_logout_is_named_and_not_cached() {
        let request = serde_json::from_value::<Request>(
            json!({ "kind": "serviceLogout", "service": "course" }),
        )
        .unwrap();
        assert!(!storage::cacheable(&request));
        // 白名单之外的服务名要能解析出来但落不了地。
        assert!(matches!(
            serde_json::from_value::<Request>(
                json!({ "kind": "serviceLogout", "service": "portal" })
            )
            .unwrap(),
            Request::ServiceLogout { .. }
        ));
    }
    #[test]
    fn portal_requests_are_named_and_not_cached() {
        for kind in [
            json!({ "kind": "portalStatus" }),
            json!({ "kind": "portalDetect" }),
            json!({ "kind": "portalLogout" }),
        ] {
            let request = serde_json::from_value::<Request>(kind).unwrap();
            assert!(!storage::cacheable(&request));
        }
    }
    #[test]
    fn department_setting_requests_are_named() {
        assert!(matches!(
            serde_json::from_value::<Request>(json!({ "kind": "departments" })).unwrap(),
            Request::Departments
        ));
        assert!(matches!(
            serde_json::from_value::<Request>(json!({
                "kind": "setDepartment", "value": "数学科学学院"
            }))
            .unwrap(),
            Request::SetDepartment { .. }
        ));
        // 本院通知走公开的 news 通道，页签标识必须与前端 sources 里的 id 一致。
        assert!(matches!(
            serde_json::from_value::<Request>(json!({
                "kind": "news", "source": "college", "page": 1
            }))
            .unwrap(),
            Request::News { .. }
        ));
    }
    #[test]
    fn authentication_has_distinct_recovery() {
        for (s, c) in [
            ("40002", "sms"),
            ("40077", "courseSms"),
            ("会话已过期", "auth"),
            (
                "登录已失效（token invalid）。请重新运行 `campuscard login`",
                "auth",
            ),
            // 课堂实录的失效要单独成码：报成 auth 会把用户推去重新登录教学网，
            // 播放器里的「重试连接」只会再撞一次 401。
            ("好学登录已失效，请重新登录", "haoxueAuth"),
            ("未登录好学课堂实录", "haoxueAuth"),
            ("超时", "timeout"),
            ("TIMETABLE_SOURCE_UNAVAILABLE", "noTimetable"),
            ("课表数据缺少 course", "unavailable"),
        ] {
            assert_eq!(problem(anyhow!(s)).code, c)
        }
    }
    #[test]
    fn errors_do_not_leak_urls_or_tokens() {
        let p = problem(anyhow!("GET https://host?token=secret failed"));
        assert!(!p.message.contains("secret"));
        assert!(!p.message.contains("https"));
    }
}
