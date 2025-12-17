(function ($) {
  "use strict";

  var fullHeight = function () {
    $(".js-fullheight").css("height", $(window).height());
    $(window).resize(function () {
      $(".js-fullheight").css("height", $(window).height());
    });
  };
  fullHeight();

  $(".toggle-password").click(function () {
    $(this).toggleClass("fa-eye fa-eye-slash");
    var input = $($(this).attr("toggle"));
    if (input.attr("type") === "password") {
      input.attr("type", "text");
    } else {
      input.attr("type", "password");
    }
  });

  var supabaseClient = window.supabaseClient;
  var authConfig = window.authConfig || {};
  var loginForm = $(".signin-form");
  var usernameField = $("#username-field");
  var passwordField = $("#password-field");
  var submitButton = $("#login-submit");
  var loader = $("#sign-in-loader");
  var feedback = $("#login-feedback");
  var toastContainer = $("#toast-container");
  var isLoginPage = loginForm.length > 0;
  var adminEmail = authConfig.adminUser || "";
  var adminPassword = authConfig.adminPassword || "";
  var dashboardPath = authConfig.dashboardPath || "dashboard.html";
  var loginPath = authConfig.loginPath || "index.html";

  var setLoading = function (isLoading) {
    if (!loginForm.length) return;
    var formControls = loginForm.find("input, button, a");
    formControls.prop("disabled", isLoading);
    submitButton.toggleClass("disabled", isLoading);
    if (isLoading) {
      loader.removeClass("d-none");
    } else {
      loader.addClass("d-none");
    }
  };

  var showFeedback = function (message, variant) {
    if (!feedback.length) return;
    if (!message) {
      feedback.addClass("d-none").removeClass("alert-danger alert-success alert-info");
      feedback.text("");
      return;
    }
    var intent = variant || "danger";
    feedback
      .removeClass("d-none alert-danger alert-success alert-info")
      .addClass("alert-" + intent);
    feedback.text(message);
  };

  var showToast = function (message, variant) {
    if (!toastContainer.length || !message) return;
    var intent = variant || "info";
    var toastId = "toast-" + Date.now();
    var toast = $(
      '<div class="toast align-items-center text-white bg-' +
        intent +
        ' border-0" role="alert" aria-live="assertive" aria-atomic="true" data-delay="3000" id="' +
        toastId +
        '">' +
        '<div class="d-flex">' +
        '<div class="toast-body">' +
        message +
        "</div>" +
        '<button type="button" class="ml-2 mb-1 close text-white" data-dismiss="toast" aria-label="Close">' +
        '<span aria-hidden="true">&times;</span>' +
        "</button>" +
        "</div>" +
        "</div>"
    );
    toastContainer.append(toast);
    toast.toast({ delay: 3000 });
    toast.toast("show");
    toast.on("hidden.bs.toast", function () {
      toast.remove();
    });
  };

  var persistSession = function (session) {
    if (!session || !session.access_token || !session.refresh_token) return;
    try {
      localStorage.setItem(
        "supabase.auth.session",
        JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        })
      );
    } catch (e) {
      console.warn("Unable to persist auth session", e);
    }
  };

  var restorePersistedSession = async function () {
    if (!supabaseClient) return;
    try {
      var savedSession = localStorage.getItem("supabase.auth.session");
      if (!savedSession) return;
      var parsed = JSON.parse(savedSession);
      if (parsed && parsed.access_token && parsed.refresh_token) {
        await supabaseClient.auth.setSession({
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token,
        });
      }
    } catch (e) {
      console.warn("Unable to restore saved session", e);
    }
  };

  var redirectTo = function (path) {
    window.location.href = path;
  };

  var guardAccess = async function () {
    if (!supabaseClient) {
      showFeedback("Unable to initialize authentication client.");
      return;
    }

    await restorePersistedSession();
    var sessionResponse = await supabaseClient.auth.getSession();
    if (sessionResponse.error) {
      showFeedback(sessionResponse.error.message || "Unable to check session state.");
      return;
    }

    var session = sessionResponse.data && sessionResponse.data.session;
    if (session && session.access_token) {
      if (isLoginPage) {
        showToast("Session restored. Redirecting…", "info");
        redirectTo(dashboardPath);
      }
      return;
    }

    if (!isLoginPage) {
      redirectTo(loginPath);
    }
  };

  var handleLogin = async function (event) {
    event.preventDefault();
    if (!supabaseClient) {
      showFeedback("Supabase client is not available.");
      return;
    }

    var email = adminEmail || usernameField.val().trim();
    var password = adminPassword || passwordField.val();

    if (!email || !password) {
      showFeedback("Missing credentials. Please contact an administrator.");
      return;
    }

    showFeedback("", "");
    setLoading(true);
    try {
      var response = await supabaseClient.auth.signInWithPassword({
        email: email,
        password: password,
      });

      if (response.error) {
        showFeedback(response.error.message || "Unable to sign in.");
        return;
      }

      if (response.data && response.data.session) {
        persistSession(response.data.session);
        showToast("Signed in successfully.", "success");
        setTimeout(function () {
          redirectTo(dashboardPath);
        }, 800);
      } else {
        showFeedback("No session returned. Please try again.");
      }
    } catch (error) {
      showFeedback(error.message || "Unexpected error during sign-in.");
    } finally {
      setLoading(false);
    }
  };

  var initAuthFlow = async function () {
    if (supabaseClient && adminEmail && !usernameField.val()) {
      usernameField.val(adminEmail);
    }
    if (isLoginPage) {
      loginForm.on("submit", handleLogin);
    }
    await guardAccess();
  };

  initAuthFlow().catch(function (error) {
    showFeedback(error.message || "Failed to initialize authentication.");
  });
})(jQuery);
