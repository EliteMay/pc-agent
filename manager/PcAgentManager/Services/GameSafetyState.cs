namespace PcAgentManager.Services;

public sealed record GameSafetyTransition(
    bool EnteredGame,
    bool ExitedGame,
    bool ShouldPauseAgent,
    bool ShouldResumeAgent);

public sealed class GameSafetyState
{
    public bool IsGameRunning { get; private set; }

    public bool ResumeAgentAfterGame { get; private set; }

    public GameSafetyTransition Observe(
        bool gameRunning,
        bool agentRunning,
        bool resumeWhenGameEndsIfNotRunning = false)
    {
        if (gameRunning && !IsGameRunning)
        {
            IsGameRunning = true;
            ResumeAgentAfterGame =
                agentRunning || resumeWhenGameEndsIfNotRunning;

            return new(
                EnteredGame: true,
                ExitedGame: false,
                ShouldPauseAgent: agentRunning,
                ShouldResumeAgent: false);
        }

        if (!gameRunning && IsGameRunning)
        {
            var shouldResume = ResumeAgentAfterGame;
            IsGameRunning = false;
            ResumeAgentAfterGame = false;

            return new(
                EnteredGame: false,
                ExitedGame: true,
                ShouldPauseAgent: false,
                ShouldResumeAgent: shouldResume);
        }

        return new(
            EnteredGame: false,
            ExitedGame: false,
            ShouldPauseAgent: false,
            ShouldResumeAgent: false);
    }

    public void RequestResumeAfterGame()
    {
        if (IsGameRunning)
        {
            ResumeAgentAfterGame = true;
        }
    }

    public void CancelResumeAfterGame()
    {
        ResumeAgentAfterGame = false;
    }

    public void Reset()
    {
        IsGameRunning = false;
        ResumeAgentAfterGame = false;
    }
}
