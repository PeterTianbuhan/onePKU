package me.petertian.onepku

import me.petertian.onepku.data.curriculum.CreditRange
import me.petertian.onepku.data.curriculum.Plan
import me.petertian.onepku.data.curriculum.PlanAlternative
import me.petertian.onepku.data.curriculum.PlanCourse
import me.petertian.onepku.data.curriculum.PlanGroup
import me.petertian.onepku.data.curriculum.PlanIndexEntry
import me.petertian.onepku.data.curriculum.PlanRequirement
import me.petertian.onepku.data.curriculum.TopRequirement
import me.petertian.onepku.data.curriculum.CurriculumEngine
import me.petertian.onepku.data.curriculum.CurriculumEngine.CourseStatus
import me.petertian.onepku.data.curriculum.CurriculumEngine.CurrentCourse
import me.petertian.onepku.data.curriculum.CurriculumEngine.MatchVia
import me.petertian.onepku.data.curriculum.CurriculumEngine.Progress
import me.petertian.onepku.data.curriculum.CurriculumEngine.ScoreRow
import me.petertian.onepku.data.curriculum.CurriculumEngine.Section
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 培养方案规则的单测:这些规则与桌面端 src/lib/curriculum.ts 一一对应。 */
class CurriculumEngineTest {

    private fun score(name: String, credits: String, mark: String, category: String, year: String = "24-25") =
        ScoreRow(name, credits, mark, category, "$year·1", year)

    /** 一份带要求树的合成方案:公共基础(英语/体育/思政) + 专业必修 + 通识。 */
    private fun plan() = Plan(
        id = "2025-测试院系-测试专业",
        cohort = 2025,
        major = "测试专业",
        title = "测试专业",
        // 大类总额与子系列对得上,才测得出分级后的求和;选修课程故意少于大类(自主选修没写要求)。
        totalCredits = CreditRange(92.0, 102.0),
        topRequirements = listOf(
            TopRequirement("1", "公共基础课程", 22.0, 28.0, "学分"),
            TopRequirement("2", "专业必修课程", 40.0, 40.0, "学分"),
            TopRequirement("3", "选修课程", 30.0, 40.0, "学分"),
        ),
        requirements = listOf(
            PlanRequirement("1-1", "1", "大学英语", "2～8 学分", 2.0, 8.0, "学分"),
            PlanRequirement("1-2", "1", "公共体育", "4 学分", 4.0, 4.0, "学分"),
            PlanRequirement("1-3", "1", "思想政治理论", "16 学分", 16.0, 16.0, "学分"),
            PlanRequirement("2-1", "2", "专业必修", "40 学分", 40.0, 40.0, "学分"),
            PlanRequirement("3-1", "3", "通识教育课", "12 学分", 12.0, 12.0, "学分"),
        ),
        groups = listOf(
            PlanGroup("1.1", "1", name = "大学英语", courses = listOf(PlanCourse(name = "英语基础A（一）", credits = 4.0))),
            PlanGroup("1.2", "1", name = "体育", courses = listOf(PlanCourse(name = "体育基础课", credits = 1.0))),
            PlanGroup(
                "2.1", "2", name = "专业必修",
                courses = listOf(
                    PlanCourse(name = "高等数学A（一）", credits = 5.0),
                    PlanCourse(name = "力学", credits = 3.0),
                    PlanCourse(name = "概率统计", credits = null),
                ),
            ),
            PlanGroup(
                "3.1", "3", name = "通识",
                courses = listOf(PlanCourse(name = "学科导论", credits = 2.0)),
                alternatives = listOf(PlanAlternative(name = "替代导论", credits = 2.0, replaces = "学科导论")),
            ),
        ),
    )

    /**
     * 仿 2025 物理学院-物理学:三大类总额只在课程组里写,专业核心课只按方向分列,
     * 要求树里既没有 2-2 也没有大类总额。
     */
    private fun physicsPlan() = Plan(
        id = "2025-物理学院-物理学",
        cohort = 2025,
        school = "物理学院",
        major = "物理学",
        title = "物理学",
        totalCredits = CreditRange(140.0, 152.0),
        requirements = listOf(
            PlanRequirement("1-1", "1", "公共必修课", "33～39 学分", 33.0, 39.0, "学分"),
            PlanRequirement("1-2", "1", "通识教育课", "12 学分", 12.0, 12.0, "学分"),
            PlanRequirement("2-1", "2", "专业基础课", "46 学分", 46.0, 46.0, "学分"),
            PlanRequirement("2-3", "2", "毕业论文", "6 学分", 6.0, 6.0, "学分"),
            PlanRequirement("3-1", "3", "专业选修课", "15 学分", 15.0, 15.0, "学分"),
        ),
        groups = listOf(
            PlanGroup("1", null, name = "公共基础课程", min = 45.0, max = 51.0, unit = "学分"),
            PlanGroup("2", null, name = "专业必修课程", min = 70.0, max = 76.0, unit = "学分"),
            PlanGroup("3", null, name = "选修课程", min = 25.0, max = 25.0, unit = "学分"),
            PlanGroup("2.1", "2", name = "专业基础课", min = 46.0, max = 46.0, unit = "学分"),
            PlanGroup("2.2", "2", name = "专业核心课"),
            PlanGroup(
                "2.2-1", "2.2", name = "物理学：24 学分", min = 24.0, max = 24.0, unit = "学分",
                courses = listOf(PlanCourse(name = "量子力学", credits = 4.0)),
            ),
            PlanGroup(
                "2.2-2", "2.2", name = "应用物理学一（应用物理与技术）：21 学分", min = 21.0, max = 21.0, unit = "学分",
                courses = listOf(PlanCourse(name = "固体物理", credits = 3.0), PlanCourse(name = "量子力学", credits = 4.0)),
            ),
        ),
    )

    private fun section(progress: Progress, id: String): Section =
        progress.sections.flatMap { listOf(it) + it.children }.first { it.id == id }    @Test
    fun `课程名规范化统一全角括号序号与空白`() {
        assertEquals("高等数学a(1)", CurriculumEngine.normalizeCourseName("高等数学A（一）"))
        assertEquals("高等数学a(1)", CurriculumEngine.normalizeCourseName("高等数学 A (Ⅰ) "))
        assertEquals("线性代数", CurriculumEngine.normalizeCourseName("线性 代 数"))
        assertEquals("大学物理(2)", CurriculumEngine.normalizeCourseName("大学物理（下）"))
        assertEquals("综合英语", CurriculumEngine.normalizeCourseName("综合“英语”"))
    }

    @Test
    fun `变体基名剥离实验班与班号`() {
        assertEquals("数据结构与算法", CurriculumEngine.variantBase("数据结构与算法(实验班)"))
        assertEquals("数学分析", CurriculumEngine.variantBase("数学分析(3班)"))
        assertEquals("线性代数", CurriculumEngine.variantBase("线性代数实验班"))
        assertEquals("线性代数", CurriculumEngine.variantBase("线性代数荣誉"))
    }

    @Test
    fun `成绩状态判定`() {
        assertEquals(CourseStatus.PASSED, CurriculumEngine.scoreStatus("85"))
        assertEquals(CourseStatus.FAILED, CurriculumEngine.scoreStatus("59"))
        listOf("合格", "P", "EX", "通过", "A", "B+", "C-", "优秀").forEach {
            assertEquals("对 $it", CourseStatus.PASSED, CurriculumEngine.scoreStatus(it))
        }
        listOf("不合格", "NP", "F", "不及格").forEach {
            assertEquals("对 $it", CourseStatus.FAILED, CurriculumEngine.scoreStatus(it))
        }
        assertEquals(CourseStatus.WITHDRAWN, CurriculumEngine.scoreStatus("W"))
        listOf("", "IP", "I", "未公布").forEach {
            assertEquals("对 '$it'", CourseStatus.IN_PROGRESS, CurriculumEngine.scoreStatus(it))
        }
        assertEquals(CourseStatus.OTHER, CurriculumEngine.scoreStatus("缓考"))
    }

    @Test
    fun `精确名匹配命中对应学分系列`() {
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("高等数学A（一）", "5", "90", "专业必修")), emptyList())
        val hit = section(p, "2-1").courses.single()
        assertEquals(MatchVia.NAME, hit.via)
        assertEquals(5.0, section(p, "2-1").earned, 0.001)
    }

    @Test
    fun `变体匹配在精确名失败后生效并回填方案学分`() {
        // 成绩单上没有学分,靠方案里的 5 分回填。
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("高等数学A（一）实验班", "", "88", "专业必修")), emptyList())
        val hit = section(p, "2-1").courses.single()
        assertEquals(MatchVia.VARIANT, hit.via)
        assertEquals(5.0, hit.credits!!, 0.001)
    }

    @Test
    fun `可选课程按被替代项归入同一系列`() {
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("替代导论", "2", "80", "通识选修")), emptyList())
        assertEquals(MatchVia.ALTERNATIVE, section(p, "3-1").courses.single().via)
    }

    @Test
    fun `公共课关键词匹配不作用于专业课`() {
        val sports = CurriculumEngine.computeProgress(plan(), listOf(score("太极拳", "1", "良好", "体育课")), emptyList())
        assertEquals(MatchVia.KEYWORD, section(sports, "1-2").courses.single().via)

        // 名称命中体育关键词,但类别是专业:不抢关键词,落到待确认。
        val major = CurriculumEngine.computeProgress(plan(), listOf(score("太极拳", "1", "良好", "专业必修")), emptyList())
        assertEquals("太极拳", major.pending.single().name)
    }

    @Test
    fun `课程类别兜底与未匹配进入待确认`() {
        val general = CurriculumEngine.computeProgress(plan(), listOf(score("人工智能伦理", "2", "85", "通识选修")), emptyList())
        assertEquals(MatchVia.CATEGORY, section(general, "3-1").courses.single().via)

        val unknown = CurriculumEngine.computeProgress(plan(), listOf(score("一门没听过的课", "2", "85", "其他")), emptyList())
        assertEquals(1, unknown.pending.size)
        assertNull(unknown.pending.single().sectionId)
    }

    @Test
    fun `手动归类优先于一切,不计入单独归档`() {
        val overrides = mapOf(
            CurriculumEngine.normalizeCourseName("一门没听过的课") to "2-1",
            CurriculumEngine.normalizeCourseName("学科导论") to CurriculumEngine.IGNORE,
        )
        val p = CurriculumEngine.computeProgress(
            plan(),
            listOf(score("一门没听过的课", "2", "85", "其他"), score("学科导论", "2", "90", "通识选修")),
            emptyList(),
            overrides,
        )
        assertEquals(MatchVia.OVERRIDE, section(p, "2-1").courses.single().via)
        assertEquals(0, p.pending.size)
        assertTrue(p.ignored.any { it.name == "学科导论" })
    }

    @Test
    fun `不及格课程保留在列表但不贡献学分`() {
        val p = CurriculumEngine.computeProgress(
            plan(),
            listOf(score("高等数学A（一）", "5", "40", "专业必修"), score("力学", "3", "70", "专业必修")),
            emptyList(),
        )
        val major = section(p, "2-1")
        assertEquals(2, major.courses.size)
        assertEquals(1, major.passedCount)
        assertEquals(3.0, major.earned, 0.001)
    }

    @Test
    fun `方案与成绩单都没有学分时计入未知学分,不静默当零`() {
        // 成绩单没学分,方案里这门课也没写学分。
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("概率统计", "", "85", "专业必修")), emptyList())
        assertEquals(1, p.unknownCredits)
        assertEquals(0.0, section(p, "2-1").earned, 0.001)
        assertEquals(1, section(p, "2-1").passedCount)
    }

    @Test
    fun `成绩单缺学分时按方案回填`() {
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("力学", "", "85", "专业必修")), emptyList())
        assertEquals(0, p.unknownCredits)
        assertEquals(3.0, section(p, "2-1").earned, 0.001)
    }

    @Test
    fun `在修课程没填学分就不进统计`() {
        val p = CurriculumEngine.computeProgress(
            plan(),
            listOf(score("力学", "3", "80", "专业必修")),
            listOf(
                CurrentCourse("c1", "力学", "25-26 学年第 1 学期", true),
                CurrentCourse("c2", "高等数学A（一）", "25-26 学年第 1 学期", true),
            ),
        )
        val major = section(p, "2-1")
        // 在修的那门已与成绩表去重,只剩一门;没填学分就不进 earned 也不进 inProgress。
        assertEquals(1, major.courses.size)
        assertEquals(1, major.inProgressCourses.size)
        assertEquals("高等数学A（一）", major.inProgressCourses.single().name)
        assertEquals(3.0, major.earned, 0.001)
        assertEquals(0.0, major.inProgress, 0.001)
        assertEquals(1, major.passedCount)
        assertEquals(0, p.unknownCredits)
    }

    @Test
    fun `填了学分的在修课程按桌面端计入在修弧`() {
        val p = CurriculumEngine.computeProgress(
            plan(),
            listOf(score("力学", "3", "80", "专业必修")),
            listOf(CurrentCourse("c2", "高等数学A（一）", "25-26 学年第 1 学期", true)),
            manualCredits = mapOf(CurriculumEngine.normalizeCourseName("高等数学A（一）") to 5.0),
        )
        val major = section(p, "2-1")
        assertEquals(5.0, major.inProgress, 0.001)
        assertEquals(3.0, major.earned, 0.001)
        assertEquals(5.0, section(p, "2").inProgress, 0.001)
        assertEquals(5.0, p.inProgress, 0.001)
        assertEquals(3.0, p.earned, 0.001)
    }

    @Test
    fun `在修课程的学分不从方案回填`() {
        // 方案里"高等数学A（一）"写着 5 分,但在修的课只认用户填的。
        val p = CurriculumEngine.computeProgress(
            plan(), emptyList(), listOf(CurrentCourse("c2", "高等数学A（一）", "25-26 学年第 1 学期", true)),
        )
        assertEquals(null, section(p, "2-1").inProgressCourses.single().credits)
        assertEquals(0.0, p.inProgress, 0.001)
    }

    @Test
    fun `在修课程填 0 学分算填过了`() {
        // 习题课与部分思政课确实是 0 分,0 不能当成"没填"。
        val p = CurriculumEngine.computeProgress(
            plan(), emptyList(), listOf(CurrentCourse("c2", "高等数学A（一）", "25-26 学年第 1 学期", true)),
            manualCredits = mapOf(CurriculumEngine.normalizeCourseName("高等数学A（一）") to 0.0),
        )
        val major = section(p, "2-1")
        assertEquals(0.0, major.inProgressCourses.single().credits!!, 0.001)
        assertEquals(0.0, major.inProgress, 0.001)
    }

    @Test
    fun `手填学分优先于成绩源自带的学分`() {
        val p = CurriculumEngine.computeProgress(
            plan(), listOf(score("力学", "3", "80", "专业必修")), emptyList(),
            manualCredits = mapOf(CurriculumEngine.normalizeCourseName("力学") to 0.0),
        )
        val major = section(p, "2-1")
        assertEquals(0.0, major.courses.single().credits!!, 0.001)
        assertEquals(0.0, major.earned, 0.001)
        assertEquals(1, major.passedCount)
    }

    @Test
    fun `习题课不认作在修课程`() {
        val p = CurriculumEngine.computeProgress(
            plan(), emptyList(),
            listOf(
                CurrentCourse("c2", "高等数学A（一）", "25-26 学年第 1 学期", true),
                CurrentCourse("c3", "高等数学A（一）习题课", "25-26 学年第 1 学期", true),
            ),
        )
        val major = section(p, "2-1")
        assertEquals(listOf("高等数学A（一）"), major.inProgressCourses.map { it.name })
        assertTrue(p.pending.none { it.name.contains("习题") })
    }

    @Test
    fun `成绩未公布的课算在修不算已修`() {
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("力学", "3", "未公布", "专业必修")), emptyList())
        val major = section(p, "2-1")
        assertEquals(0, major.courses.size)
        assertEquals(1, major.inProgressCourses.size)
        assertEquals(0.0, major.earned, 0.001)
        assertEquals(3.0, major.inProgress, 0.001)
        assertEquals(0, p.unknownCredits)
    }

    @Test
    fun `父级汇总子级学分`() {
        val p = CurriculumEngine.computeProgress(plan(), listOf(score("高等数学A（一）", "5", "90", "专业必修")), emptyList())
        assertEquals(5.0, section(p, "2").earned, 0.001)
        assertEquals(5.0, p.earned, 0.001)
    }

    @Test
    fun `英语分级把这一类定住,大类按子系列求和`() {
        val p = CurriculumEngine.computeProgress(plan(), emptyList(), emptyList(), englishLevel = "C")
        val english = section(p, "1-1")
        assertEquals(4.0, english.min!!, 0.001)
        assertEquals(4.0, english.max!!, 0.001)
        assertEquals("4 学分（C 级）", english.requirement)

        // 公共基础课程原本 22~28,英语定成 4 之后就是 4 + 体育 4 + 思政 16。
        assertEquals(24.0, section(p, "1").min!!, 0.001)
        assertEquals(24.0, section(p, "1").max!!, 0.001)
        // 毕业总学分:24 + 40 + 30。选修大类求和只有 12,不在方案写的 30~40 内,保留方案值。
        assertEquals(30.0, section(p, "3").min!!, 0.001)
        assertEquals(94.0, p.required!!, 0.001)
    }

    @Test
    fun `英语差额不再补进通识教育课`() {
        val p = CurriculumEngine.computeProgress(plan(), emptyList(), emptyList(), englishLevel = "C")
        assertEquals(12.0, section(p, "3-1").min!!, 0.001)
        val texts = (p.sections + p.sections.flatMap { it.children }).map { "${it.requirement}|${it.note}" }
        assertFalse(texts.any { it.contains("补齐") })
    }

    @Test
    fun `分级两端不越出方案自述的区间`() {
        val top = CurriculumEngine.computeProgress(plan(), emptyList(), emptyList(), englishLevel = "Y")
        assertEquals(8.0, section(top, "1-1").min!!, 0.001)
        assertEquals(28.0, section(top, "1").min!!, 0.001)   // 原本的上限
        val bottom = CurriculumEngine.computeProgress(plan(), emptyList(), emptyList(), englishLevel = "C+")
        assertEquals(2.0, section(bottom, "1-1").min!!, 0.001)
        assertEquals(22.0, section(bottom, "1").min!!, 0.001) // 原本的下限
    }

    @Test
    fun `免修按第 3 条获 2 学分,与 C+ 同级`() {
        assertEquals(4, CurriculumEngine.englishLevelInfo("C")?.credits)
        assertEquals(2, CurriculumEngine.englishLevelInfo("C+")?.credits)
        assertEquals(2, CurriculumEngine.englishLevelInfo("exempt")?.credits)
        val p = CurriculumEngine.computeProgress(plan(), emptyList(), emptyList(), englishLevel = "exempt")
        // 按 0 分会把公共基础压到 20,低于方案自己写的下限 22,那是错的。
        assertEquals(2.0, section(p, "1-1").min!!, 0.001)
        assertEquals(22.0, section(p, "1").min!!, 0.001)
    }

    @Test
    fun `英语折在公共必修课里时按弹性六分定住`() {
        val p = CurriculumEngine.computeProgress(physicsPlan(), emptyList(), emptyList(), englishLevel = "B")
        // 这份方案没有单列英语;公共必修课 33~39 那 6 分跨度正是英语弹性,唯一候选才敢认定。
        assertEquals(37.0, section(p, "1-1").min!!, 0.001)
        assertTrue(section(p, "1-1").note!!.contains("弹性 2～8"))
        assertEquals(49.0, section(p, "1").min!!, 0.001)      // 37 + 通识 12
        assertEquals(144.0, p.required!!, 0.001)              // 49 + 70 + 25,在方案的 140~152 内
    }

    @Test
    fun `英语专业与留学生不套用分级`() {
        listOf(
            plan().copy(title = "汉语言文学（留学生）", track = "留学生"),
            plan().copy(title = "英语", major = "英语", school = "外国语学院"),
        ).forEach { tweaked ->
            val p = CurriculumEngine.computeProgress(tweaked, emptyList(), emptyList(), englishLevel = "C")
            assertEquals(2.0, section(p, "1-1").min!!, 0.001)
            assertEquals(22.0, section(p, "1").min!!, 0.001)
        }
    }

    @Test
    fun `方案没写大类总额时退回课程组的学分`() {
        val p = CurriculumEngine.computeProgress(physicsPlan(), emptyList(), emptyList())
        assertEquals(45.0, section(p, "1").min!!, 0.001)
        assertEquals(70.0, section(p, "2").min!!, 0.001)
        assertEquals(25.0, section(p, "3").min!!, 0.001)
    }

    @Test
    fun `要求表缺失的子系列按课程组补回,总额取大类余额`() {
        val p = CurriculumEngine.computeProgress(physicsPlan(), emptyList(), emptyList())
        val core = section(p, "2-2")
        assertEquals("专业核心课", core.name)
        // 专业必修 70 学分,专业基础课 46 + 毕业论文 6,剩下的都归专业核心课。
        assertEquals(18.0, core.min!!, 0.001)
        assertEquals(24.0, core.max!!, 0.001)
        assertEquals("18～24 学分", core.requirement)

        val hit = CurriculumEngine.computeProgress(
            physicsPlan(), listOf(score("量子力学", "4", "90", "专业必修")), emptyList(),
        )
        // 方向课表挂在 2.2-1 下,课程应落到补出来的 2-2,而不是堆在大类本身。
        assertEquals(4.0, section(hit, "2-2").earned, 0.001)
        assertEquals(4.0, section(hit, "2").earned, 0.001)
        assertTrue(section(hit, "2").courses.isEmpty())
    }

    @Test
    fun `没有要求表的方案退回分组树`() {
        val groupPlan = plan().copy(requirements = emptyList(), topRequirements = emptyList())
        val p = CurriculumEngine.computeProgress(groupPlan, listOf(score("高等数学A（一）", "5", "90", "专业必修")), emptyList())
        assertFalse(p.usesRequirements)
        assertEquals(5.0, section(p, "2.1").earned, 0.001)
    }

    @Test
    fun `版本回退到不晚于入学年份的最新版`() {
        assertEquals(2021, CurriculumEngine.defaultVersion(index(), 2022))
        assertEquals(2021, CurriculumEngine.defaultVersion(index(), 2019))
        assertEquals(2025, CurriculumEngine.defaultVersion(index(), null))
        assertEquals(2025, CurriculumEngine.defaultVersion(index(), 2025))
    }

    @Test
    fun `推断按重合门数排序,平手时比重合率并提示核对`() {
        val scores = listOf(
            score("高等数学A（一）", "5", "90", "专业必修", "25-26"),
            score("力学", "3", "85", "专业必修", "25-26"),
            score("线性代数", "3", "88", "专业必修", "25-26"),
        )
        val inferred = CurriculumEngine.inferProfile(scores, emptyList(), index())
        assertEquals(2025, inferred.cohort)
        assertEquals("甲-窄口径", inferred.candidates.first().id)
        assertEquals(2, inferred.candidates.first().matched)
        assertEquals(2, inferred.candidates.first().total)
        assertTrue(inferred.evidence.any { it.contains("重合门数相同") })
    }

    @Test
    fun `门户院系命中时先限定候选范围`() {
        val scores = listOf(score("高等数学A（一）", "5", "90", "专业必修", "25-26"))
        val inferred = CurriculumEngine.inferProfile(scores, emptyList(), index(), department = "院系甲")
        assertEquals("院系甲", inferred.narrowedBySchool)
        assertTrue(inferred.candidates.isNotEmpty())
        assertTrue(inferred.candidates.all { it.school == "院系甲" })
        assertTrue(inferred.evidence.any { it.contains("限定候选范围") })
    }

    @Test
    fun `本院系没有重合时退回全校并说明原因`() {
        val scores = listOf(score("只有院系乙开的课", "2", "90", "专业必修", "25-26"))
        val inferred = CurriculumEngine.inferProfile(scores, emptyList(), index(), department = "院系甲")
        assertTrue(inferred.candidates.all { it.school == "院系乙" })
        assertTrue(inferred.evidence.any { it.contains("改按全校方案排序") })
    }

    @Test
    fun `零重合不猜专业`() {
        val scores = listOf(score("一门谁都不在方案里的课", "2", "90", "任选", "24-25"))
        val inferred = CurriculumEngine.inferProfile(scores, emptyList(), index())
        assertTrue(inferred.candidates.isEmpty())
        assertEquals(2024, inferred.cohort)
        assertEquals(2021, inferred.version)
        assertTrue(inferred.evidence.any { it.contains("请手动选择专业") })
    }

    @Test
    fun `真实方案数据里物理学院的专业核心课能补齐`() {
        // 这份是随应用打包的离线数据,路径随 Gradle 工作目录变化,找不到就跳过。
        val file = listOf(
            "../../data/curriculum/2025/2025-物理学院-物理学.json",
            "../data/curriculum/2025/2025-物理学院-物理学.json",
        ).map { java.io.File(it) }.firstOrNull { it.isFile }
        org.junit.Assume.assumeTrue("离线方案数据不在工作目录里", file != null)
        val real = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromString(Plan.serializer(), file!!.readText())
        val coreCourse = real.groups.first { it.id == "2.2-1" }.courses.first().name
        val p = CurriculumEngine.computeProgress(
            real, listOf(score(coreCourse, "4", "90", "专业必修")), emptyList(),
        )

        assertEquals(listOf("1", "2", "3"), p.sections.map { it.id })
        assertEquals(45.0, section(p, "1").min!!, 0.001)
        assertEquals(70.0, section(p, "2").min!!, 0.001)
        assertEquals(listOf("2-1", "2-2", "2-3"), section(p, "2").children.map { it.id })
        assertEquals("专业核心课", section(p, "2-2").name)
        assertEquals(18.0, section(p, "2-2").min!!, 0.001)
        // 方向课表挂在 2.2-1 下,课程要归到补出来的 2-2,不能散在大类本身。
        assertEquals(4.0, section(p, "2-2").earned, 0.001)
        assertTrue(section(p, "2").courses.isEmpty())

        // 真实方案把专业核心课分了五个方向;选定物理学方向后按 24 学分,大类回到 76。
        val splits = CurriculumEngine.directionSplits(real)
        assertEquals(listOf("2-2"), splits.map { it.sectionId })
        assertEquals(5, splits.single().options.size)
        val withTrack = CurriculumEngine.computeProgress(
            real, emptyList(), emptyList(), directions = mapOf("2-2" to "2.2-1"),
        )
        assertEquals(24.0, section(withTrack, "2-2").min!!, 0.001)
        assertEquals(46.0 + 24.0 + 6.0, section(withTrack, "2").min!!, 0.001)

        // 英语折在公共必修课里,分级同样能定住这一类,并把大类与毕业总学分一起落下来。
        val graded = CurriculumEngine.computeProgress(
            real, emptyList(), emptyList(), englishLevel = "B", directions = mapOf("2-2" to "2.2-1"),
        )
        assertEquals(37.0, section(graded, "1-1").min!!, 0.001)   // 33 + (6 - 2)
        assertEquals(49.0, section(graded, "1").min!!, 0.001)     // 37 + 通识 12
        assertEquals(76.0, section(graded, "2").min!!, 0.001)
        assertEquals(150.0, graded.required!!, 0.001)             // 49 + 76 + 25,在方案的 140~152 内
    }

    @Test
    fun `选定细分方向后按该方向的学分要求算,大类总额随之重算`() {
        val splits = CurriculumEngine.directionSplits(physicsPlan())
        assertEquals(1, splits.size)
        assertEquals("2-2", splits.single().sectionId)
        assertEquals("专业核心课", splits.single().name)
        assertEquals(listOf("2.2-1", "2.2-2"), splits.single().options.map { it.groupId })

        val p = CurriculumEngine.computeProgress(
            physicsPlan(), emptyList(), emptyList(), directions = mapOf("2-2" to "2.2-1"),
        )
        assertEquals(24.0, section(p, "2-2").min!!, 0.001)
        // 46 + 24 + 6 = 76,落在方案给的 70~76 区间里才敢改大类总额。
        assertEquals(76.0, section(p, "2").min!!, 0.001)
        assertEquals(76.0, section(p, "2").max!!, 0.001)
        assertTrue(section(p, "2-2").note!!.contains("物理学"))

        val other = CurriculumEngine.computeProgress(
            physicsPlan(), emptyList(), emptyList(), directions = mapOf("2-2" to "2.2-2"),
        )
        assertEquals(21.0, section(other, "2-2").min!!, 0.001)
        assertEquals(73.0, section(other, "2").min!!, 0.001)
    }

    @Test
    fun `没选的方向独有的课不计入这一类,共享的课照旧`() {
        val directions = mapOf("2-2" to "2.2-1")
        val rows = listOf(score("固体物理", "3", "90", "专业必修"), score("量子力学", "4", "90", "专业必修"))
        val p = CurriculumEngine.computeProgress(physicsPlan(), rows, emptyList(), directions = directions)
        // 量子力学两个方向表里都有,选了物理学方向仍算专业核心课。
        assertEquals(4.0, section(p, "2-2").earned, 0.001)
        // 固体物理只在应用物理学一的方向表里,不能替物理学方向凑学分。
        assertTrue(p.pending.any { it.name == "固体物理" })
    }

    @Test
    fun `父类已有总额的模块清单不当成方向`() {
        // 信科那种"专业选修课 20 学分 + 六个模块"的方案不该冒出方向选择。
        val grouped = plan().copy(
            groups = plan().groups + listOf(
                PlanGroup("3.2", "3", name = "模块清单", min = 12.0, max = 12.0, unit = "学分"),
                PlanGroup("3.2-1", "3.2", name = "模块一", min = 6.0, max = 6.0, unit = "学分"),
                PlanGroup("3.2-2", "3.2", name = "模块二", min = 6.0, max = 6.0, unit = "学分"),
            ),
        )
        assertTrue(CurriculumEngine.directionSplits(grouped).isEmpty())
    }

    private fun index(): List<PlanIndexEntry> = listOf(
        PlanIndexEntry(
            id = "甲-窄口径", cohort = 2025, school = "院系甲", major = "窄口径", title = "窄口径专业",
            core = listOf("高等数学A（一）", "力学"), file = "2025/甲-窄口径.json",
        ),
        PlanIndexEntry(
            id = "甲-宽口径", cohort = 2025, school = "院系甲", major = "宽口径", title = "宽口径专业",
            core = listOf("高等数学A（一）", "力学", "概率论", "复变函数", "偏微分方程"), file = "2025/甲-宽口径.json",
        ),
        PlanIndexEntry(
            id = "乙-乙专业", cohort = 2025, school = "院系乙", major = "乙", title = "乙专业",
            core = listOf("高等数学A（一）", "只有院系乙开的课"), file = "2025/乙-乙专业.json",
        ),
        PlanIndexEntry(
            id = "旧版-丙专业", cohort = 2021, school = "院系丙", major = "丙", title = "丙专业",
            core = listOf("高等数学A（一）"), file = "2021/丙-丙专业.json",
        ),
        PlanIndexEntry(
            id = "甲-项目制", cohort = 2025, school = "院系甲", major = "项目", title = "项目制",
            kind = "project", core = listOf("高等数学A（一）", "力学"), file = "2025/甲-项目制.json",
        ),
    )
}
