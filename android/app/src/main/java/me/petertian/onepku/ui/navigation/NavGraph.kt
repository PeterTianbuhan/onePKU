package me.petertian.onepku.ui.navigation

import android.net.Uri
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.School
import androidx.compose.material.icons.outlined.Today
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import me.petertian.onepku.ui.assignments.AssignmentDetailScreen
import me.petertian.onepku.ui.assignments.AssignmentsScreen
import me.petertian.onepku.ui.calendar.CalendarScreen
import me.petertian.onepku.ui.card.CardScreen
import me.petertian.onepku.ui.classroom.ClassroomScreen
import me.petertian.onepku.ui.courses.CourseDetailScreen
import me.petertian.onepku.ui.courses.CourseListScreen
import me.petertian.onepku.ui.curriculum.CurriculumProfileScreen
import me.petertian.onepku.ui.curriculum.CurriculumScreen
import me.petertian.onepku.ui.grades.GradesScreen
import me.petertian.onepku.ui.login.LoginScreen
import me.petertian.onepku.ui.mine.MineScreen
import me.petertian.onepku.ui.news.NewsDetailScreen
import me.petertian.onepku.ui.news.NewsScreen
import me.petertian.onepku.ui.settings.SettingsScreen
import me.petertian.onepku.ui.today.TodayScreen

object Routes {
    const val LOGIN = "login"
    const val TODAY = "today"
    const val COURSES = "courses"
    const val NEWS = "news"
    const val MINE = "mine"

    const val COURSE_DETAIL = "course/{courseId}?name={name}"
    const val ASSIGNMENTS = "assignments"
    const val ASSIGNMENT_DETAIL = "assignment/{courseId}/{contentId}?title={title}"
    const val GRADES = "grades"
    const val CURRICULUM = "curriculum"
    const val CURRICULUM_PROFILE = "curriculumProfile"
    const val CARD = "card"
    const val CLASSROOM = "classroom"
    const val CALENDAR = "calendar"
    const val SETTINGS = "settings"
    const val NEWS_DETAIL = "newsDetail/{kind}?id={id}&url={url}&title={title}&source={source}"

    fun courseDetail(id: String, name: String) = "course/$id?name=${Uri.encode(name)}"
    fun assignmentDetail(courseId: String, contentId: String, title: String) =
        "assignment/$courseId/$contentId?title=${Uri.encode(title)}"

    /** kind: portal(学校/部门,用 id 取正文)| web(教务部/信科/图书馆,按 url 抓取) */
    fun newsDetail(kind: String, id: String, url: String, title: String, source: String) =
        "newsDetail/$kind?id=${Uri.encode(id)}&url=${Uri.encode(url)}&title=${Uri.encode(title)}&source=${Uri.encode(source)}"
}

private data class TopDestination(val route: String, val label: String, val icon: ImageVector)

private val topDestinations = listOf(
    TopDestination(Routes.TODAY, "今日", Icons.Outlined.Today),
    TopDestination(Routes.COURSES, "课程", Icons.Outlined.School),
    TopDestination(Routes.NEWS, "通知", Icons.Outlined.Notifications),
    TopDestination(Routes.MINE, "我的", Icons.Outlined.Person),
)

@Composable
fun AppNavHost() {
    val nav = rememberNavController()
    val backStackEntry by nav.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val showBottomBar = currentRoute in topDestinations.map { it.route }

    Scaffold(
        bottomBar = {
            if (showBottomBar) {
                NavigationBar {
                    topDestinations.forEach { dest ->
                        NavigationBarItem(
                            selected = currentRoute == dest.route,
                            onClick = {
                                nav.navigate(dest.route) {
                                    popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(dest.icon, contentDescription = dest.label) },
                            label = { Text(dest.label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = Routes.TODAY,
            modifier = Modifier.padding(padding),
        ) {
            composable(Routes.LOGIN) { LoginScreen(nav) }
            composable(Routes.TODAY) { TodayScreen(nav) }
            composable(Routes.COURSES) { CourseListScreen(nav) }
            composable(Routes.NEWS) { NewsScreen(nav) }
            composable(Routes.MINE) { MineScreen(nav) }

            composable(
                Routes.COURSE_DETAIL,
                arguments = listOf(
                    navArgument("courseId") { type = NavType.StringType },
                    navArgument("name") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { CourseDetailScreen(nav) }

            composable(Routes.ASSIGNMENTS) { AssignmentsScreen(nav) }

            composable(
                Routes.ASSIGNMENT_DETAIL,
                arguments = listOf(
                    navArgument("courseId") { type = NavType.StringType },
                    navArgument("contentId") { type = NavType.StringType },
                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { AssignmentDetailScreen(nav) }

            composable(Routes.GRADES) { GradesScreen(nav) }
            composable(Routes.CURRICULUM) { CurriculumScreen(nav) }
            composable(Routes.CURRICULUM_PROFILE) { CurriculumProfileScreen(nav) }
            composable(Routes.CARD) { CardScreen(nav) }
            composable(Routes.CLASSROOM) { ClassroomScreen(nav) }
            composable(Routes.CALENDAR) { CalendarScreen(nav) }
            composable(Routes.SETTINGS) { SettingsScreen(nav) }

            composable(
                Routes.NEWS_DETAIL,
                arguments = listOf(
                    navArgument("kind") { type = NavType.StringType },
                    navArgument("id") { type = NavType.StringType; defaultValue = "" },
                    navArgument("url") { type = NavType.StringType; defaultValue = "" },
                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                    navArgument("source") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { NewsDetailScreen(nav) }
        }
    }
}

/** 未登录时强制进入登录页:由今日页负责检查并跳转。 */
fun NavHostController.toLogin() {
    navigate(Routes.LOGIN) {
        popUpTo(0) { inclusive = true }
    }
}

fun NavHostController.back() {
    popBackStack()
}
